const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const fsPromises = require('fs/promises');
const { exec } = require('child_process');
const { promisify } = require('util');
const { Auth } = require('msmc');
const { Client, Authenticator } = require('minecraft-launcher-core');
const { Client: DiscordRPCClient } = require('@xhayper/discord-rpc');

const execAsync = promisify(exec);

const FALCOM_DIR = path.join(process.env.APPDATA, '.falcom-client');
const MS_AUTH_CACHE_PATH = path.join(FALCOM_DIR, 'ms-auth-cache.json');

const mcLauncher = new Client();

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
let gameIsRunning = false;

mcLauncher.on('debug', (e) => {
  mainWindow?.webContents.send('launch-log', `[DEBUG] ${e}`);
});
mcLauncher.on('data', (e) => {
  mainWindow?.webContents.send('launch-log', `[GAME] ${e}`);
});
mcLauncher.on('progress', (e) => {
  mainWindow?.webContents.send('launch-progress', e);
});
mcLauncher.on('close', (code) => {
  gameIsRunning = false;
  mainWindow?.webContents.send('launch-status', {
    state: 'closed',
    message: `Minecraft se cerró (código ${code}).`
  });
  setDiscordActivity({
    details: 'En el launcher',
    state: 'Explorando Spyder Client'
  });
});

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
    mainWindow.maximize();
    mainWindow.show();
  });

  mainWindow.loadFile('index.html');
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

ipcMain.handle('launch-game', async (event, { userSession, instance, ram }) => {
  if (gameIsRunning) {
    return { success: false, error: 'Minecraft ya se está ejecutando.' };
  }
  if (!userSession) {
    return { success: false, error: 'No hay sesión activa.' };
  }

  try {
    let authorization;

    if (userSession.type === 'microsoft') {
      if (!userSession.mclcToken) {
        return { success: false, error: 'La sesión de Microsoft no tiene token válido. Vuelve a iniciar sesión.' };
      }
      authorization = userSession.mclcToken;
    } else {
      authorization = Authenticator.getAuth(userSession.name);
    }

    const instanceName = instance || 'default';
    const instancePath = path.join(FALCOM_DIR, 'instances', instanceName);

    if (!fs.existsSync(instancePath)) {
      fs.mkdirSync(instancePath, { recursive: true });
    }

    const maxGB = Math.max(1, parseFloat(ram) || 4);
    const maxMB = Math.round(maxGB * 1024);
    const minMB = Math.max(1024, Math.floor(maxMB / 2));

    const versionJarPath = path.join(instancePath, 'versions', '1.20.1', '1.20.1.jar');
    const alreadyInstalled = fs.existsSync(versionJarPath);

    gameIsRunning = true;
    mainWindow?.webContents.send('launch-log', `[LAUNCHER] Carpeta de la instancia: ${instancePath}`);
    mainWindow?.webContents.send('launch-status', {
      state: alreadyInstalled ? 'launching' : 'downloading',
      message: alreadyInstalled
        ? 'Iniciando Minecraft...'
        : 'Descargando Minecraft 1.20.1 (primera vez)...'
    });

    const opts = {
      authorization,
      root: instancePath,
      version: {
        number: '1.20.1',
        type: 'release'
      },
      memory: { max: `${maxMB}M`, min: `${minMB}M` }
    };

    await mcLauncher.launch(opts);

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

app.whenReady().then(() => {
  if (!fs.existsSync(FALCOM_DIR)) {
    fs.mkdirSync(FALCOM_DIR, { recursive: true });
  }

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});