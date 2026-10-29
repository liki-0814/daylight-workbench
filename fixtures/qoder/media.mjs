// Redacted from live Qoder media probes (2026-10-29). Prompts, ids and signed URLs are synthetic;
// the image is a 1x1 PNG instead of the real ~1.1MB data URL.
export const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
export const imageResponse = { data: [{ url: `data:image/png;base64,${PNG_B64}` }], created: 1793244006, usage: { completion_tokens: 1120, prompt_tokens: 7 } };
export const videoId = 'video_01m62vrk5xav6jm1r3akz57bpk';
export const videoUrl = 'https://oss-ap-southeast-1.aliyuncs.com/redacted/output.mp4?Expires=1795837072&Signature=redacted';
const base = { id: videoId, object: 'video', model: 'wan30', seconds: '5', size: '1280x720', created_at: 1793245072, expires_at: 1795837072, usage: { supply_account: '', supply_model: '', supply_region: 'global' } };
export const videoQueued = { ...base, status: 'queued', progress: 0, prompt: 'synthetic' };
export const videoRunning = { ...base, status: 'in_progress', progress: 50, prompt: 'synthetic' };
export const videoCompleted = { ...base, status: 'completed', progress: 100, completed_at: 1793245230, video_url: videoUrl, prompt: 'synthetic', usage: { duration: 5, input_video_duration: 0, output_video_duration: 5, fps: 30, video_count: 1, SR: 720, ratio: '16:9', supply_account: '', supply_model: '', supply_region: 'global' } };
export const serverError = { success: false, traceId: '0daacf1d31ce7c616aa96f344a68c55e', msgCode: 500, msgInfo: 'Internal Server Error', message: 'Internal Server Error' };
