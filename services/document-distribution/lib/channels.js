"use strict";

// The "ESB-lite" piece: a plain channel-name -> async-handler registry, not a literal event
// emitter — a caller needs to await the result and return success/failure to the monolith, which
// a fire-and-forget EventEmitter doesn't fit. Adding a future channel is one new
// registerChannel() call, not a change anywhere else.
const channels = new Map();

const registerChannel = (name, handler) => channels.set(name, handler);

const distribute = async (channel, args) => {
  const handler = channels.get(channel);
  if (!handler) throw new Error(`Unknown distribution channel: ${channel}`);
  return handler(args);
};

module.exports = { registerChannel, distribute };
