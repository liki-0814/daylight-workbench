// 设置的即时保存：每个控件一次写一个键（POST /api/proxy/settings/<key>）。返回错误文案，成功返回空串。
// 反向代理页的配置卡和设置页共用，不让两处各写一份。
export async function saveProxySetting(store, key, value) {
  try { await store.api.request('settings/' + key, { value }); return ''; }
  catch (error) { return error.message || '保存失败'; }
  finally { await store.refresh(); }
}
