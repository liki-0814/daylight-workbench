// A tool batch is atomic in message protocols, even when results complete out of order.
// Keep results in arrival order and attachments associated with their original call IDs.
export function toolTurns(messages, param) {
  const turns = [], seen = new Set();
  const fail = () => { throw Object.assign(new Error('工具调用与结果不完整、重复或顺序不匹配；请修复历史后重试'), {
    status: 400, code: 'invalid_tool_sequence', param, retryable: false,
  }); };
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (message.role === 'tool') fail();
    const turn = { message, results: [] };
    turns.push(turn);
    if (!message.toolCalls?.length) continue;
    if (message.role !== 'assistant') fail();
    const pending = new Set();
    for (const call of message.toolCalls) {
      if (typeof call.id !== 'string' || !call.id || seen.has(call.id)) fail();
      pending.add(call.id); seen.add(call.id);
    }
    while (pending.size) {
      const result = messages[++i];
      if (!result || result.role !== 'tool' || !pending.delete(result.toolCallId)) fail();
      turn.results.push(result);
    }
  }
  return turns;
}
