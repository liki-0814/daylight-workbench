import {readJson,writeJson,serial} from './store.js';

const valid = row => row && Number.isFinite(row.factor) && row.factor >= 0.25 && row.factor <= 4 && Number.isInteger(row.samples) && row.samples > 0 && Number.isFinite(row.updatedAt);
const keyOf = ({provider,model,protocol,upstreamProtocol,effort}) => JSON.stringify([provider,model,protocol,upstreamProtocol,effort ?? 'auto']);

// Stores aggregate scale factors only, never prompts, output, or per-request usage.
export class TokenCalibration {
  constructor(file, rows = {}, writable = true) {
    this.file = file;
    this.rows = new Map(Object.entries(rows).filter(([,row]) => valid(row)));
    this.writable = writable;
    this.write = serial();
  }
  static async load(file) {
    try {
      const saved = await readJson(file, {version:1,models:{}});
      if (saved.version !== 1 || !saved.models || typeof saved.models !== 'object' || Array.isArray(saved.models)) throw Error('Invalid calibration');
      return new TokenCalibration(file,saved.models);
    } catch {
      // An optional display cache must not prevent inference or overwrite a bad file.
      return new TokenCalibration(file,{},false);
    }
  }
  begin(context) {
    const key = keyOf(context);
    return {factor:this.rows.get(key)?.factor ?? 1, observe:sample => this.observe(key,sample)};
  }
  async observe(key,{estimated,actual,reasoningVisible,reasoningSummary,reasoningTokens}) {
    if (!this.writable || !Number.isFinite(estimated) || !Number.isFinite(actual) || estimated < 40 || actual < 40) return;
    // A hidden thought budget cannot be inferred from the visible answer.
    if (reasoningTokens > 0 && (!reasoningVisible || reasoningSummary)) return;
    const ratio = actual / estimated, previous = this.rows.get(key);
    if (ratio < 0.25 || ratio > 4 || previous?.samples >= 3 && (ratio / previous.factor < 1/3 || ratio / previous.factor > 3)) return;
    const alpha = previous ? 0.2 : 1;
    this.rows.set(key,{factor:(previous?.factor ?? 1)*(1-alpha)+ratio*alpha,samples:Math.min((previous?.samples ?? 0)+1,1000),updatedAt:Date.now()});
    if (this.rows.size > 1024) this.rows.delete([...this.rows].sort((a,b) => a[1].updatedAt-b[1].updatedAt)[0][0]);
    // Serialize atomic writes. Failure only loses persistence, not the response.
    await this.write(() => writeJson(this.file,{version:1,models:Object.fromEntries(this.rows)})).catch(() => {});
  }
}
