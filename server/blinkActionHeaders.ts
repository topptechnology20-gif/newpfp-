import type { Request } from "express";

export const BANTAH_BRO_BLINK_PATH_PREFIX = "/api/actions/";
export const BANTAH_BRO_ACTIONS_JSON_PATH = "/actions.json";
export const SOLANA_MAINNET_CAIP2 = "solana:mainnet";

export const BLINK_ACTION_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, X-Blockchain-Ids, X-Action-Version, Accept-Encoding, Content-Encoding",
  "Access-Control-Expose-Headers": "X-Blockchain-Ids, X-Action-Version",
  "X-Blockchain-Ids": SOLANA_MAINNET_CAIP2,
  "X-Action-Version": "2.4",
  "Cache-Control": "no-store",
};

export function isBlinkActionRequest(req: Request) {
  return req.path === BANTAH_BRO_ACTIONS_JSON_PATH || req.path.startsWith(BANTAH_BRO_BLINK_PATH_PREFIX);
}
