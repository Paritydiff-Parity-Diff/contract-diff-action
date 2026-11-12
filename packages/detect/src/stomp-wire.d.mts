export interface StompFrame {
  length: number;
  command: string;
  headers: Record<string, string>;
  headerEntries: [string, string][];
  body: Buffer;
}
export function decodeStompFrame(input: Uint8Array): StompFrame;
export function stompFrameStream(onFrame: (frame: StompFrame, bytes: Buffer) => void): {
  push(input: Uint8Array): void;
  finish(): void;
};
