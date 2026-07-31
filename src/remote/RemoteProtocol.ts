export const remoteProtocolVersion = 1 as const;

export type RemoteGatewayPhase =
  | 'disabled'
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'error';

export interface RemoteGatewayStatus {
  phase: RemoteGatewayPhase;
  label: string;
  lastConnectedAt?: number;
  error?: string;
}

export interface RemoteHostInfo {
  hostId: string;
  status: RemoteGatewayStatus;
}

export interface UsbTestSession {
  hostId: string;
  relayUrl: string;
  deviceSerial: string;
}

export interface RemoteGatewayConfig {
  enabled: boolean;
  relayUrl: string;
  autoReconnect: boolean;
}

export interface RemoteStateSnapshot {
  workspace: string;
  connection: string;
  connectionLabel: string;
  rootThreadId?: string;
  rootStatus?: string;
  rootName?: string;
  busy: boolean;
  pendingInstructions: number;
  approvalPending: boolean;
  questionPending: boolean;
  latestMessage?: string;
  updatedAt: number;
}

export interface RemoteInstruction {
  messageId: string;
  deviceId?: string;
  text: string;
  createdAt: number;
}

export type RemoteInstructionOutcome = 'started' | 'queued' | 'rejected' | 'failed';

export interface RemoteInstructionResult {
  messageId: string;
  outcome: RemoteInstructionOutcome;
  detail: string;
  time: number;
}

export interface RemoteEnvelope<T = unknown> {
  version: typeof remoteProtocolVersion;
  messageId: string;
  type: string;
  hostId: string;
  createdAt: string;
  payload: T;
}

export function remoteEnvelope<T>(
  hostId: string,
  type: string,
  payload: T,
  messageId: string = crypto.randomUUID(),
): RemoteEnvelope<T> {
  return {
    version: remoteProtocolVersion,
    messageId,
    type,
    hostId,
    createdAt: new Date().toISOString(),
    payload,
  };
}
