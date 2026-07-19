export {
  encodeClientMessage,
  decodeClientMessage,
  encodeServerMessage,
  decodeServerMessage,
  type ClientMessage,
  type ServerMessage,
  type DocHead,
  type SharePermission,
  type ShareInfo,
} from "./protocol.ts";
export { identityCipher, digest, type Cipher } from "./cipher.ts";
export { deriveVaultKey, VaultCipher, ShareCipher, deriveSpaceKey, DEFAULT_SPACE_ID, MasterKeySpaces } from "./crypto.ts";
export type { SpaceKeySource } from "./crypto.ts";
export {
  SyncClient,
  type SyncClientOptions,
  type SyncDocState,
  type SyncHost,
  type SocketLike,
  type SyncStatus,
  type AwarenessState,
} from "./client.ts";
export { ShareClient, type ShareClientOptions } from "./share-client.ts";
export {
  readSpaces,
  spaceOf,
  createSpace,
  renameSpace,
  moveNote,
  recordCopy,
  readAudit,
  SPACES_MAP,
  DOC_SPACES_MAP,
  type Space,
  type SpaceAuditKind,
  type SpaceAuditEvent,
} from "./spaces.ts";
