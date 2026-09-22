const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const fsPromises = require('fs/promises');
const https = require('https');
const extractZip = require('extract-zip');
const { exec } = require('child_process');
const crypto = require('crypto');
const { promisify } = require('util');
const { Auth } = require('msmc');
const { Launch } = require('minecraft-java-core');
const { Client: DiscordRPCClient } = require('@xhayper/discord-rpc');
const { autoUpdater } = require('electron-updater');

const execAsync = promisify(exec);

const FALCOM_DIR = path.join(process.env.APPDATA, '.spyderclient');
const LEGACY_FALCOM_DIR = path.join(process.env.APPDATA, '.falcom-client');
const MS_AUTH_CACHE_PATH = path.join(FALCOM_DIR, 'ms-auth-cache.json');

function migrateLegacyDataFolder() {
  try {
    if (!fs.existsSync(FALCOM_DIR) && fs.existsSync(LEGACY_FALCOM_DIR)) {
      fs.renameSync(LEGACY_FALCOM_DIR, FALCOM_DIR);
      console.log('Datos migrados de .falcom-client a .spyderclient');
    }
  } catch (err) {
    console.error('No se pudo migrar la carpeta de datos anterior:', err);
  }
}

migrateLegacyDataFolder();

const DISCORD_CLIENT_ID = '1543391531019407420';
const discordRpc = new DiscordRPCClient({ clientId: DISCORD_CLIENT_ID });
let discordRpcReady = false;
const appStartTimestamp = new Date();

discordRpc.on('ready', () => {
  discordRpcReady = true;
  setDiscordActivity({
    details: 'En el launcher',
    state: 'Explorando Spyder Client'
  });
});

function connectDiscordRpc() {
  discordRpc.login().catch((err) => {
    console.error('No se pudo conectar con Discord (¿está abierto Discord de escritorio?):', err.message);
    setTimeout(connectDiscordRpc, 15000);
  });
}

connectDiscordRpc();

function setDiscordActivity({ details, state, extra = {} }) {
  if (!discordRpcReady) return;
  discordRpc.user?.setActivity({
    details,
    state,
    startTimestamp: appStartTimestamp,
    largeImageKey: 'spyder_logo',
    largeImageText: 'Spyder Client',
    instance: false,
    buttons: [
      { label: 'Descargar Launcher', url: 'https://discord.gg/spyderstudios' }
    ],
    ...extra
  }).catch((err) => console.error('No se pudo actualizar el estado de Discord:', err.message));
}

ipcMain.handle('update-discord-presence', (event, { details, state }) => {
  setDiscordActivity({ details, state });
  return true;
});

let mainWindow;
let splashWindow;
let gameIsRunning = false;

let splashStartTime = 0;

function createSplashWindow() {
  splashStartTime = Date.now();
  splashWindow = new BrowserWindow({
    width: 360,
    height: 460,
    frame: false,
    resizable: false,
    movable: true,
    transparent: true,
    alwaysOnTop: true,
    center: true,
    skipTaskbar: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  splashWindow.loadFile('splash.html');
}

function setSplashStatus(text) {
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.webContents.send('splash-status', text);
  }
}

const mcLauncher = new Launch();

mcLauncher.on('data', (line) => {
  mainWindow?.webContents.send('launch-log', `[GAME] ${line}`);
});
mcLauncher.on('progress', (progress, size) => {
  mainWindow?.webContents.send('launch-progress', { type: 'archivos', task: progress, total: size });
});
mcLauncher.on('extract', (name) => {
  mainWindow?.webContents.send('launch-log', `[LAUNCHER] Extrayendo: ${name}`);
});
mcLauncher.on('patch', (line) => {
  mainWindow?.webContents.send('launch-log', `[LOADER] ${line}`);
});
mcLauncher.on('close', () => {
  gameIsRunning = false;
  mainWindow?.webContents.send('launch-status', {
    state: 'closed',
    message: 'Minecraft se cerró.'
  });
  setDiscordActivity({
    details: 'En el launcher',
    state: 'Explorando Spyder Client'
  });
});
function describeLaunchError(err) {
  const inner = err?.error instanceof Error ? err.error : err;
  if (inner instanceof Error) {
    return { message: inner.message, stack: inner.stack };
  }
  if (inner && typeof inner === 'object') {
    try {
      return { message: JSON.stringify(inner), stack: null };
    } catch (e) {
      return { message: String(inner), stack: null };
    }
  }
  return { message: String(inner), stack: null };
}

mcLauncher.on('error', (err) => {
  const desc = describeLaunchError(err);
  console.error('[launch] Error del proceso de Minecraft:', desc.message);
  if (desc.stack) console.error(desc.stack);
  gameIsRunning = false;
  mainWindow?.webContents.send('launch-status', {
    state: 'error',
    message: desc.message?.includes?.('ENOENT')
      ? 'No se encontró Java en este equipo. Instala Java (17 o superior) e inténtalo de nuevo.'
      : `Error al lanzar Minecraft: ${desc.message}`
  });
});

const MIN_SPLASH_MS = 1800;
const UPDATE_CHECK_TIMEOUT_MS = 12000;

let mainWindowReady = false;
let updateCheckSettled = false;
let splashClosed = false;

function settleUpdateCheck() {
  if (updateCheckSettled) return;
  updateCheckSettled = true;
  tryFinishSplash();
}

function tryFinishSplash() {
  if (splashClosed) return;
  if (!mainWindowReady || !updateCheckSettled) return;

  const elapsed = Date.now() - splashStartTime;
  const remaining = Math.max(0, MIN_SPLASH_MS - elapsed);

  setTimeout(() => {
    splashClosed = true;
    if (splashWindow && !splashWindow.isDestroyed()) {
      splashWindow.close();
      splashWindow = null;
    }
    mainWindow.maximize();
    mainWindow.show();
  }, remaining);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 950,
    height: 600,
    title: 'Spyder Client',
    resizable: true,
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  mainWindow.once('ready-to-show', () => {
    mainWindowReady = true;
    tryFinishSplash();
  });

  mainWindow.loadFile('index.html');

  setTimeout(settleUpdateCheck, UPDATE_CHECK_TIMEOUT_MS);
}

ipcMain.handle('msmc-login', async () => {
  try {
    const authManager = new Auth('select_account');

    const xboxManager = await authManager.launch('electron', {
      parent: mainWindow
    });

    const token = await xboxManager.getMinecraft();

    if (!token.profile || token.profile.error || !token.profile.name || !token.profile.id) {
      console.error('Perfil de Minecraft incompleto tras el login:', token.profile);
      return {
        success: false,
        error: 'No se pudo obtener tu perfil de Minecraft. Es posible que Mojang esté limitando las peticiones; espera unos segundos e intenta de nuevo.'
      };
    }

    try {
      const refreshToken = xboxManager.save();
      fs.writeFileSync(MS_AUTH_CACHE_PATH, JSON.stringify({ refreshToken }));
    } catch (cacheErr) {
      console.error('No se pudo guardar la sesión de Microsoft para la próxima vez:', cacheErr);
    }

    return {
      success: true,
      user: {
        name: token.profile.name,
        uuid: token.profile.id,
        mclcToken: token.mclc()
      }
    };
  } catch (err) {
    console.error('Error de autenticación Microsoft:', err);

    return {
      success: false,
      error: err && err.message ? err.message : 'No se pudo iniciar sesión con Microsoft'
    };
  }
});

ipcMain.handle('restore-microsoft-session', async () => {
  try {
    if (!fs.existsSync(MS_AUTH_CACHE_PATH)) {
      return { success: false };
    }

    const saved = JSON.parse(fs.readFileSync(MS_AUTH_CACHE_PATH, 'utf-8'));
    if (!saved || !saved.refreshToken) {
      return { success: false };
    }

    const authManager = new Auth('select_account');
    const xboxManager = await authManager.refresh(encodeURIComponent(saved.refreshToken));
    const token = await xboxManager.getMinecraft();

    const newRefreshToken = xboxManager.save();
    fs.writeFileSync(MS_AUTH_CACHE_PATH, JSON.stringify({ refreshToken: newRefreshToken }));

    if (!token.profile || token.profile.error || !token.profile.name || !token.profile.id) {
      console.error('Perfil de Minecraft incompleto al restaurar sesión:', token.profile);
      return { success: false };
    }

    return {
      success: true,
      user: {
        name: token.profile.name,
        uuid: token.profile.id,
        mclcToken: token.mclc()
      }
    };
  } catch (err) {
    console.error('No se pudo restaurar la sesión de Microsoft guardada:', err);
    if (err && err.response && typeof err.response.text === 'function') {
      try {
        const bodyText = await err.response.text();
        console.error('Detalle del error de Microsoft:', bodyText);
      } catch (readErr) {
        console.error('No se pudo leer el detalle del error:', readErr);
      }
    }
    try {
      if (fs.existsSync(MS_AUTH_CACHE_PATH)) fs.unlinkSync(MS_AUTH_CACHE_PATH);
    } catch (_) {}
    return { success: false };
  }
});

ipcMain.handle('clear-microsoft-session', () => {
  try {
    if (fs.existsSync(MS_AUTH_CACHE_PATH)) fs.unlinkSync(MS_AUTH_CACHE_PATH);
  } catch (err) {
    console.error('No se pudo borrar la sesión de Microsoft guardada:', err);
  }
  return true;
});

async function getGpuName() {
  try {
    const gpuInfo = await app.getGPUInfo('complete');
    const renderer = gpuInfo?.auxAttributes?.glRenderer || '';

    const match = renderer.match(/ANGLE \([^,]+,\s*([^,]+),/);
    if (match) {
      return match[1]
        .replace(/\s*\(0x[0-9a-fA-F]+\)/, '')
        .replace(/\s+Direct3D\d*.*/i, '')
        .trim();
    }
    if (renderer) return renderer;

    const device = gpuInfo?.gpuDevice?.[0];
    if (device) return `GPU (vendor ${device.vendorId}, device ${device.deviceId})`;

    return null;
  } catch (err) {
    console.error('No se pudo obtener información de la GPU:', err);
    return null;
  }
}

async function getDiskSpace() {
  try {
    if (process.platform === 'win32') {
      const drive = path.parse(FALCOM_DIR).root.replace('\\', '');
      const { stdout } = await execAsync(
        `powershell -NoProfile -Command "Get-CimInstance Win32_LogicalDisk -Filter \\"DeviceID='${drive}'\\" | Select-Object -Property Size,FreeSpace | ConvertTo-Json"`
      );
      const data = JSON.parse(stdout);
      if (data && data.Size && data.FreeSpace) {
        return {
          drive,
          total: Math.round((Number(data.Size) / 1024 ** 3) * 10) / 10,
          free: Math.round((Number(data.FreeSpace) / 1024 ** 3) * 10) / 10
        };
      }
      return null;
    } else {
      const { stdout } = await execAsync('df -k /');
      const parts = stdout.trim().split('\n')[1].split(/\s+/);
      const totalKB = Number(parts[1]);
      const freeKB = Number(parts[3]);
      return {
        drive: '/',
        total: Math.round((totalKB / 1024 ** 2) * 10) / 10,
        free: Math.round((freeKB / 1024 ** 2) * 10) / 10
      };
    }
  } catch (err) {
    console.error('No se pudo obtener espacio en disco:', err);
    return null;
  }
}

ipcMain.handle('get-hardware-info', async () => {
  const [gpu, disk] = await Promise.all([getGpuName(), getDiskSpace()]);
  return { gpu, disk };
});

ipcMain.handle('open-folder', (event, folderPath) => {
  shell.openPath(folderPath);
});

ipcMain.handle('apply-skin', async (event, { accessToken, variant, filePath }) => {
  try {
    const fileBuffer = await fsPromises.readFile(filePath);
    const blob = new Blob([fileBuffer], { type: 'image/png' });

    const form = new FormData();
    form.append('variant', variant === 'slim' ? 'slim' : 'classic');
    form.append('file', blob, 'skin.png');

    const response = await fetch('https://api.minecraftservices.com/minecraft/profile/skins', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`
      },
      body: form
    });

    const data = await response.json().catch(() => null);

    if (!response.ok) {
      if (response.status === 429) {
        return { success: false, error: 'Mojang está limitando los cambios de skin por ahora. Espera unos 15-20 segundos e inténtalo de nuevo.' };
      }
      const message = (data && (data.errorMessage || data.error)) || `Error ${response.status} al aplicar la skin`;
      return { success: false, error: message };
    }

    return { success: true, profile: data };
  } catch (err) {
    console.error('Error aplicando skin:', err);
    return { success: false, error: err.message || 'No se pudo aplicar la skin' };
  }
});

ipcMain.handle('find-premium-user', async (event, username) => {
  try {
    const response = await fetch(`https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(username)}`);

    if (response.status === 204 || !response.ok) {
      return null;
    }

    const data = await response.json();
    if (!data || !data.name || !data.id) return null;

    return { name: data.name, uuid: data.id };
  } catch (err) {
    console.error('No se pudo buscar el usuario premium:', err);
    return null;
  }
});

ipcMain.handle('get-current-skin', async (event, uuid) => {
  try {
    const cleanUuid = uuid.replace(/-/g, '');
    const response = await fetch(`https://sessionserver.mojang.com/session/minecraft/profile/${cleanUuid}`);

    if (!response.ok) {
      return null;
    }

    const data = await response.json();
    const texturesProp = data.properties?.find((p) => p.name === 'textures');
    if (!texturesProp) return null;

    const decoded = JSON.parse(Buffer.from(texturesProp.value, 'base64').toString('utf-8'));
    const skinInfo = decoded.textures?.SKIN;
    if (!skinInfo) return null;

    return {
      url: skinInfo.url,
      model: skinInfo.metadata?.model === 'slim' ? 'slim' : 'default'
    };
  } catch (err) {
    console.error('No se pudo obtener la skin actual desde Mojang:', err);
    return null;
  }
});

ipcMain.handle('get-capes', async (event, accessToken) => {
  try {
    const response = await fetch('https://api.minecraftservices.com/minecraft/profile', {
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    });

    if (!response.ok) {
      return { capes: [] };
    }

    const data = await response.json();
    const capes = (data.capes || []).map((cape) => ({
      id: cape.id,
      alias: cape.alias,
      url: cape.url,
      active: cape.state === 'ACTIVE'
    }));

    return { capes };
  } catch (err) {
    console.error('No se pudieron obtener las capas del usuario:', err);
    return { capes: [] };
  }
});

ipcMain.handle('set-active-cape', async (event, { accessToken, capeId }) => {
  try {
    let response;

    if (capeId) {
      response = await fetch('https://api.minecraftservices.com/minecraft/profile/capes/active', {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ capeId })
      });
    } else {
      response = await fetch('https://api.minecraftservices.com/minecraft/profile/capes/active', {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${accessToken}`
        }
      });
    }

    if (!response.ok) {
      if (response.status === 429) {
        return { success: false, error: 'Mojang está limitando los cambios de capa por ahora. Espera unos 15-20 segundos e inténtalo de nuevo.' };
      }
      const data = await response.json().catch(() => null);
      const message = (data && (data.errorMessage || data.error)) || `Error ${response.status} al cambiar la capa`;
      return { success: false, error: message };
    }

    return { success: true };
  } catch (err) {
    console.error('Error al cambiar la capa activa:', err);
    return { success: false, error: err.message || 'No se pudo cambiar la capa' };
  }
});

function downloadFileWithProgress(url, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    const request = (currentUrl, redirectsLeft) => {
      https.get(currentUrl, (response) => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          if (redirectsLeft <= 0) {
            reject(new Error('Demasiadas redirecciones al descargar el archivo.'));
            return;
          }
          response.resume();
          request(response.headers.location, redirectsLeft - 1);
          return;
        }

        if (response.statusCode !== 200) {
          reject(new Error(`Descarga falló con código ${response.statusCode}`));
          return;
        }

        const totalBytes = parseInt(response.headers['content-length'] || '0', 10);
        let downloadedBytes = 0;
        const fileStream = fs.createWriteStream(destPath);

        response.on('data', (chunk) => {
          downloadedBytes += chunk.length;
          if (onProgress) onProgress(downloadedBytes, totalBytes);
        });

        response.pipe(fileStream);
        fileStream.on('finish', () => fileStream.close(() => resolve()));
        fileStream.on('error', reject);
      }).on('error', reject);
    };

    request(url, 5);
  });
}

function parseJavaMajorVersion(rawOutput) {
  const match = rawOutput.match(/version "(\d+)(?:\.(\d+))?/);
  if (!match) return null;
  if (match[1] === '1' && match[2]) {
    return parseInt(match[2], 10);
  }
  return parseInt(match[1], 10);
}

async function getInstalledJavaMajorVersion() {
  try {
    const { stderr, stdout } = await execAsync('java -version');
    return parseJavaMajorVersion(stderr || stdout || '');
  } catch (err) {
    return null;
  }
}

async function checkJavaInstalled() {
  const major = await getInstalledJavaMajorVersion();
  return major !== null;
}

ipcMain.handle('check-java-installed', async () => {
  return checkJavaInstalled();
});

ipcMain.handle('get-java-info', async () => {
  const majorVersion = await getInstalledJavaMajorVersion();
  return { installed: majorVersion !== null, majorVersion };
});

ipcMain.handle('open-java-download', () => {
  shell.openExternal('https://www.java.com/es/download/');
});

function findBundledJavaExe(javaHomeDir) {
  try {
    const entries = fs.readdirSync(javaHomeDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const candidate = path.join(javaHomeDir, entry.name, 'bin', 'java.exe');
        if (fs.existsSync(candidate)) return candidate;
      }
    }
  } catch (err) {
    // carpeta no existe todavía
  }
  return null;
}

function buildOfflineUuid(username) {
  const hash = crypto.createHash('md5').update(`OfflinePlayer:${username}`).digest();
  hash[6] = (hash[6] & 0x0f) | 0x30;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  return hash.toString('hex');
}

async function ensureBundledJava(majorVersion) {
  const javaHomeDir = path.join(FALCOM_DIR, 'java', String(majorVersion));

  const existing = findBundledJavaExe(javaHomeDir);
  if (existing) return existing;

  mainWindow?.webContents.send('launch-status', {
    state: 'downloading-java',
    message: `Descargando Java ${majorVersion} (no se detectó ninguno instalado)...`
  });

  const apiUrl = `https://api.adoptium.net/v3/binary/latest/${majorVersion}/ga/windows/x64/jre/hotspot/normal/eclipse`;
  const zipPath = path.join(app.getPath('temp'), `java-${majorVersion}-jre.zip`);

  await downloadFileWithProgress(apiUrl, zipPath, (downloaded, total) => {
    mainWindow?.webContents.send('launch-progress', {
      type: 'java',
      task: downloaded,
      total: total || downloaded
    });
  });

  fs.mkdirSync(javaHomeDir, { recursive: true });
  await extractZip(zipPath, { dir: javaHomeDir });

  try {
    fs.unlinkSync(zipPath);
  } catch (err) {
    console.error('No se pudo borrar el zip temporal de Java:', err);
  }

  const exePath = findBundledJavaExe(javaHomeDir);
  if (!exePath) {
    throw new Error('No se pudo preparar Java automáticamente. Instálalo manualmente desde https://www.java.com/es/download/');
  }

  return exePath;
}

ipcMain.handle('launch-game', async (event, { userSession, instance, ram, mcVersion, loaderType, loaderBuild, downloadUrl, requiredJavaMajor }) => {
  if (gameIsRunning) {
    return { success: false, error: 'Minecraft ya se está ejecutando.' };
  }
  if (!userSession) {
    return { success: false, error: 'No hay sesión activa.' };
  }

  const installedJavaMajor = await getInstalledJavaMajorVersion();
  let javaPathOverride = null;

  if (requiredJavaMajor) {
    if (installedJavaMajor === null || installedJavaMajor !== requiredJavaMajor) {
      try {
        javaPathOverride = await ensureBundledJava(requiredJavaMajor);
      } catch (err) {
        mainWindow?.webContents.send('launch-status', { state: 'error', message: err.message });
        return { success: false, error: err.message };
      }
    }
  } else if (installedJavaMajor === null) {
    const message = 'No se encontró Java en este equipo. Instala Java (17 o superior) desde https://www.java.com/es/download/ e inténtalo de nuevo.';
    mainWindow?.webContents.send('launch-status', { state: 'error', message });
    return { success: false, error: message };
  }

  try {
    let authorization;

    if (userSession.type === 'microsoft') {
      if (!userSession.mclcToken) {
        return { success: false, error: 'La sesión de Microsoft no tiene token válido. Vuelve a iniciar sesión.' };
      }
      authorization = userSession.mclcToken;
    } else {
      authorization = {
        uuid: buildOfflineUuid(userSession.name),
        access_token: '0'
      };
    }

    const instanceName = instance || 'default';
    const instancePath = path.join(FALCOM_DIR, 'instances', instanceName);

    if (!fs.existsSync(instancePath)) {
      fs.mkdirSync(instancePath, { recursive: true });
    }

    const maxGB = Math.max(1, parseFloat(ram) || 4);
    const maxMB = Math.round(maxGB * 1024);
    const minMB = Math.max(1024, Math.floor(maxMB / 2));

    const resolvedMcVersion = mcVersion || '1.20.1';
    const hasLoader = !!loaderType;
    const versionMarkerPath = hasLoader
      ? path.join(instancePath, 'mods')
      : path.join(instancePath, 'versions', resolvedMcVersion);
    const alreadyInstalled = fs.existsSync(versionMarkerPath);

    gameIsRunning = true;
    mainWindow?.webContents.send('launch-log', `[LAUNCHER] Carpeta de la instancia: ${instancePath}`);

    if (!alreadyInstalled && downloadUrl) {
      mainWindow?.webContents.send('launch-status', {
        state: 'downloading-pack',
        message: 'Descargando modpack (primera vez)...'
      });

      const zipPath = path.join(app.getPath('temp'), `${instanceName}-pack.zip`);

      await downloadFileWithProgress(downloadUrl, zipPath, (downloaded, total) => {
        mainWindow?.webContents.send('launch-progress', {
          type: 'pack',
          task: downloaded,
          total: total || downloaded
        });
      });

      mainWindow?.webContents.send('launch-status', {
        state: 'downloading-pack',
        message: 'Extrayendo modpack...'
      });

      await extractZip(zipPath, { dir: instancePath });

      try {
        fs.unlinkSync(zipPath);
      } catch (err) {
        console.error('No se pudo borrar el zip temporal del modpack:', err);
      }
    }

    mainWindow?.webContents.send('launch-status', {
      state: 'downloading',
      message: alreadyInstalled
        ? 'Verificando archivos del juego...'
        : `Descargando Minecraft ${resolvedMcVersion}${hasLoader ? ` + ${loaderType} ${loaderBuild}` : ''} (primera vez)...`
    });

    const launchOptions = {
      path: instancePath,
      authenticator: {
        access_token: authorization.access_token,
        client_token: authorization.access_token,
        uuid: authorization.uuid,
        name: userSession.name,
        user_properties: '{}',
        meta: { type: userSession.type === 'microsoft' ? 'msa' : 'mojang', demo: false }
      },
      version: resolvedMcVersion,
      detached: false,
      loader: {
        type: loaderType || null,
        build: loaderBuild || 'latest',
        enable: hasLoader
      },
      java: {
        path: javaPathOverride || null,
        version: requiredJavaMajor || null,
        type: 'jre'
      },
      memory: {
        min: `${minMB}M`,
        max: `${maxMB}M`
      }
    };

    mcLauncher.Launch(launchOptions).catch((err) => {
      const desc = describeLaunchError(err);
      console.error('Error al lanzar Minecraft (evento tardío):', desc.message);
      if (desc.stack) console.error(desc.stack);
      gameIsRunning = false;
      mainWindow?.webContents.send('launch-status', {
        state: 'error',
        message: `Error al lanzar Minecraft: ${desc.message}`
      });
    });

    setDiscordActivity({
      details: 'Jugando Minecraft',
      state: `Instancia: ${instanceName}`
    });

    return { success: true };
  } catch (err) {
    gameIsRunning = false;
    console.error('Error al lanzar Minecraft:', err);
    mainWindow?.webContents.send('launch-status', { state: 'error', message: err.message });
    return { success: false, error: err.message || 'No se pudo iniciar Minecraft' };
  }
});

function setupAutoUpdater() {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => {
    console.log('[autoUpdater] Buscando actualizaciones...');
    setSplashStatus('Buscando actualizaciones...');
    mainWindow?.webContents.send('update-status', { state: 'checking' });
  });

  autoUpdater.on('update-available', (info) => {
    console.log('[autoUpdater] Actualización disponible:', info.version);
    setSplashStatus(`Descargando actualización v${info.version}...`);
    mainWindow?.webContents.send('update-status', { state: 'available', version: info.version });
  });

  autoUpdater.on('update-not-available', () => {
    console.log('[autoUpdater] No hay actualizaciones nuevas.');
    setSplashStatus('Iniciando launcher...');
    mainWindow?.webContents.send('update-status', { state: 'not-available' });
    settleUpdateCheck();
  });

  autoUpdater.on('error', (err) => {
    console.error('[autoUpdater] Error al buscar/descargar actualización:', err);
    setSplashStatus('Iniciando launcher...');
    mainWindow?.webContents.send('update-status', { state: 'error', message: err.message });
    settleUpdateCheck();
  });

  autoUpdater.on('download-progress', (progress) => {
    mainWindow?.webContents.send('update-progress', progress);
  });

  autoUpdater.on('update-downloaded', (info) => {
    console.log('[autoUpdater] Actualización descargada:', info.version);
    setSplashStatus('Actualización lista, iniciando...');
    mainWindow?.webContents.send('update-status', { state: 'downloaded', version: info.version });
    settleUpdateCheck();
  });

  ipcMain.handle('check-for-updates', () => {
    autoUpdater.checkForUpdates().catch((err) => console.error('Error al buscar actualizaciones:', err));
  });

  ipcMain.handle('install-update-now', () => {
    autoUpdater.quitAndInstall(true, true);
  });

  autoUpdater.checkForUpdates().catch((err) => console.error('Error al buscar actualizaciones:', err));
}

app.whenReady().then(() => {
  if (!fs.existsSync(FALCOM_DIR)) {
    fs.mkdirSync(FALCOM_DIR, { recursive: true });
  }

  createSplashWindow();
  createWindow();
  setupAutoUpdater();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});