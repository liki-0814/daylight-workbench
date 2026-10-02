// Qoder identity from the reference protocol. No multi-account/product runtime.
export function loadProfileForAccount(config) {
  return {
    name: 'qoder', hosts: { inference: config.compatUrl, openapi: config.openapiUrl, center: config.centerUrl },
    clientId: config.clientId, cosyVersion: config.cosyVersion, clientVersion: config.clientVersion,
    tokenModel: 'dual', infoPayload: ['uid', 'security_oauth_token'], envelope: 'qoder',
    session: 'store', catalog: 'live', effortGated: true, deframeExtras: false,
    headerGroups: { base: {}, inference: {
      'x-model-key': '{{modelKey}}', 'x-model-source': 'system', 'cosy-scene': 'assistant',
      'cosy-clienttype': '5', 'cosy-machinetype': '5', 'cosy-business-product': 'cli',
      'cosy-business-type': 'agent', accept: 'text/event-stream',
      'accept-encoding': 'identity', 'content-type': 'text/plain;charset=UTF-8',
    } },
  };
}
export function renderHeaderTemplates(group, variables) {
  return Object.fromEntries(Object.entries(group).map(([key, value]) => [key, value.replace(/\{\{(\w+)\}\}/g, (_, name) => {
    if (variables[name] === undefined) throw new Error('缺少协议头参数');
    return variables[name];
  })]));
}
