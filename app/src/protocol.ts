// Single import point for the wire protocol, which is the fixed contract
// shared with the gateway (see ../../protocol/v1.md). The app implements this
// exactly and never redefines its own shapes.
export * from "../../protocol/v1";
