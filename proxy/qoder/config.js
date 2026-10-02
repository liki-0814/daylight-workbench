import path from 'node:path';

export function loadConfig(dataDir, env = process.env) {
  return {
    compatUrl: env.QODER_COMPAT_URL || 'https://api3.qoder.sh',
    openapiUrl: env.QODER_OPENAPI_URL || 'https://openapi.qoder.sh',
    centerUrl: env.QODER_DYNAMIC_TEXT_CENTER_URL || 'https://center.qoder.sh',
    loginUrl: env.QODER_LOGIN_URL || 'https://qoder.com/device/selectAccounts',
    clientId: env.QODER_CLIENT_ID || 'e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb',
    clientVersion: env.QODER_CLIENT_VERSION || '1.0.41',
    cosyVersion: env.QODER_COSY_VERSION || '1.0.41',
    accountFile: path.join(dataDir, 'qoder', 'account.json'),
  };
}
