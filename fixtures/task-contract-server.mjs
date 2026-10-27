// Exercise the real HTTP server with isolated model/extension dependencies.
// CLI startup and shutdown remain covered by test/web.test.mjs.
import {createTaskWorkbench,closeWorkbench} from './workbench.mjs';
if(!process.env.WORKBENCH_DATA_DIR||!process.env.PORT)throw Error('Task contract server requires an isolated directory and port');
const server=await createTaskWorkbench(process.env.WORKBENCH_DATA_DIR);
await new Promise(resolve=>server.listen(Number(process.env.PORT),'127.0.0.1',resolve));
let stopping;
for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>{stopping ||= closeWorkbench(server);void stopping.catch(()=>{process.exitCode=1;});});
