export interface MqttPacket {
  cmd: string;
  topic?: string;
  payload?: Buffer;
  qos?: number;
  dup?: boolean;
  retain?: boolean;
  messageId?: number;
  reasonCode?: number;
  protocolVersion?: number;
  clientId?: string;
  clean?: boolean;
  keepalive?: number;
  will?: { topic: string; qos: number; retain: boolean; payload: Buffer };
  properties?: Record<string, unknown>;
  userProperties?: Record<string, string | string[]>;
  propertyIds?: number[];
  wireProperties?: {
    payloadFormatIndicator?: number;
    messageExpiryInterval?: number;
    contentType?: string;
    responseTopic?: string;
    correlationData?: Buffer;
    topicAlias?: number;
  };
}
export function mqttFrameLength(input: Uint8Array): { length: number; offset: number } | undefined;
export function decodeMqttPacket(input: Uint8Array, version?: number): MqttPacket;
export function mqttPacketStream(
  version: number,
  onPacket: (packet: MqttPacket, bytes: Buffer) => void,
): {
  push(input: Uint8Array): void;
  finish(): void;
};
