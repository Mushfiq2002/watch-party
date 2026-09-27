export type RoomStart =
  | { kind: "file"; file: File; subtitle: File | null }
  | { kind: "url"; url: string };
