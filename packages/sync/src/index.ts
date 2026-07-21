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
  type KeyEnvelope,
  type MemberInfo,
  type MemberRole,
} from "./protocol.ts";
export { identityCipher, digest, type Cipher } from "./cipher.ts";
export {
  deriveVaultKey,
  VaultCipher,
  ShareCipher,
  deriveSpaceKey,
  DEFAULT_SPACE_ID,
  MasterKeySpaces,
  wrapKey,
  unwrapKey,
} from "./crypto.ts";
export type { SpaceKeySource, WrapContext } from "./crypto.ts";
export {
  generateSeed,
  deriveIdentity,
  identityChallengeBytes,
  verifyChallenge,
  exportIdentity,
  importIdentity,
  IDENTITY_FORMAT,
  type SyncIdentity,
  type IdentityFile,
} from "./identity.ts";
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
  bootstrapTeamKey,
  createTeamVault,
  rootWrapContext,
  KEY_ID_ROOT,
  type TeamBootstrapOptions,
  type TeamBootstrapResult,
  type CreateTeamVaultOptions,
} from "./bootstrap.ts";
export { TeamAdminSession, type TeamAdminOptions } from "./team-admin.ts";
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
