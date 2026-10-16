import { decodeRequest } from '../../proxy/shared/protocol.js';

// Event fixtures implement the same execute contract as production providers.
export const eventExecution = generate => ({ raw, protocol }, context) => ({
  kind: 'events', events: generate(decodeRequest(raw, protocol), context),
});
