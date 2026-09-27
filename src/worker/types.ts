import type { MediaPublication, PeerRole } from "../shared/protocol";

export type PeerAttachment = {
  id: string;
  name: string;
  role: PeerRole;
  hostKey?: string;
  clientId: string;
  mediaToken: string;
  sfuSessionId?: string;
  publications?: MediaPublication[];
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
