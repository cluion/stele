# Security

Stele is a local-first, end-to-end-encrypted, self-hostable knowledge base. This
document describes its threat model, the cryptographic design behind team
collaboration, and — just as importantly — the boundaries of what those
guarantees do and do not cover.

If you find a vulnerability, please **do not** open a public issue. Email
`security@cluion.com` with a description and, if possible, a reproduction. We aim
to acknowledge within 72 hours.

---

## 1. Threat model

### 1.1 What we protect

- **Confidentiality of note content and file names.** The sync server stores
  only opaque encrypted blobs. It never sees plaintext, note titles, or the
  folder structure.
- **Authenticity of key distribution.** A member can verify that the team key
  they received was wrapped by the genuine team owner, not fabricated by the
  relay.
- **Authenticity of role assignment** (since 0.12). A member can verify their
  own role was assigned by the owner.
- **Forward secrecy on membership change** (since 0.11). After a member is
  removed and the key is rotated, their retained old key cannot decrypt content
  produced afterwards.
- **Per-space isolation** (since 0.13). A restricted space uses an independent
  key; members outside its access list cannot decrypt its content even though
  they hold the team key.

### 1.2 Adversaries we consider

- **A malicious or compromised sync server.** This is the central assumption:
  the server is an untrusted **blind relay**. It routes and stores ciphertext,
  enforces coarse access control, but is never trusted with plaintext or with
  the integrity of key material.
- **A network eavesdropper.** Transport is WSS in production; on top of that,
  payloads are already end-to-end encrypted.
- **A removed team member** who kept an offline copy of the old key.
- **A member outside a restricted space's access list.**
- **Another team member acting maliciously** — bounded: they can decrypt what
  their role and space access allow. Their *writes* are now author-signed and
  role-checked end-to-end (§2.8), so a viewer cannot forge accepted writes; a
  legitimate editor writing unwanted content remains an audit/social matter, not
  one cryptography prevents (§4.1).

### 1.3 Trust assumptions

- The **team owner's signing key is the root of trust.** Its public key
  (`ownerPubSign`) is distributed out-of-band inside the invite bundle and
  pinned by each member on join. Everything a member verifies chains back to it.
- The user's **device is trusted while unlocked.** Decrypted content, the vault
  key, and the identity seed live in memory and on disk on the device.
- The **CRDT is the source of truth**; the `.md` mirror on disk is plaintext by
  design (local-first), protected by the operating system's file permissions,
  not by Stele.

---

## 2. Cryptographic design

All primitives are from audited libraries (`@noble/curves`, `@noble/hashes`) and
the WebCrypto API. No hand-rolled crypto.

### 2.1 Personal vault key

`passphrase → scrypt(N=2¹⁸, r=8, p=1) → 32-byte master key`, salted with the
vault id. scrypt's work factor is the sole defense against offline brute force of
a leaked ciphertext, so it is deliberately high (OWASP's file-encryption tier).
The master key never leaves the device.

### 2.2 Member identity

A single 32-byte random seed is HKDF-expanded into two independent subkeys:

- **Ed25519** for signatures (challenge-response auth; owners also sign key
  envelopes and role credentials).
- **X25519** for key wrapping (receiving team keys sealed to your public key).

`memberId = hex(SHA-256(pubSign))`. The server enforces this binding, so a
member id is not a self-chosen label — claiming someone else's id would require a
SHA-256 collision. The seed is stored under the OS keychain via Electron
`safeStorage` (macOS Keychain / Windows DPAPI).

### 2.3 Key hierarchy

```
team root key (random 32 bytes)
   └─ HKDF(salt="stele-space-key", info=spaceId)  →  space key
        └─ HKDF(salt="stele-doc-key", info=docId) →  per-note key
             └─ AES-256-GCM   →  ciphertext  [ver][nonce 12B][ct+tag]
```

The default space's key *is* the root itself, so an existing personal vault
migrates to the space model with zero re-encryption. A **restricted space**
breaks this derivation: it gets its own random key (not derived from root), so
holding root is not enough to read it.

### 2.4 Key envelopes (team key distribution)

The owner wraps a raw key (root, or a per-space key) to a recipient's X25519
public key and relays the envelope through the blind server:

```
[ver][ephemeral X25519 pub 32B][owner Ed25519 sig 64B][AES-GCM sealed key]
```

Two defenses:

- **Owner signature** over `ephPub ‖ sealed ‖ context`. The relay has no owner
  signing key, so it cannot forge an envelope to feed a member a key for a fake
  vault. Recipients verify against the pinned `ownerPubSign`.
- **Context binding** — `{vaultId, keyId, epoch, recipientMemberId}` is folded
  into the HKDF `info` (together with the ephemeral and recipient public keys).
  ECDH already binds the recipient; the context binds against cross-vault,
  cross-key, and cross-epoch replay. A mismatch changes the derived key, so the
  GCM tag fails and the envelope is cleanly rejected.

### 2.5 Authenticated sync sessions

Challenge-response: the server issues a fresh nonce; the client signs
`"stele-auth-v1" ‖ nonce ‖ vaultId ‖ memberId` with its Ed25519 key. A team
vault refuses anonymous token-only connections — being authenticated means being
an enrolled member.

### 2.6 Role credentials (since 0.12)

The owner signs `"stele-role-cred-v1" ‖ vaultId ‖ memberId ‖ role ‖ epoch`. The
server stores and relays it; the member verifies it against `ownerPubSign` on
bootstrap. This makes **role assignment tamper-evident**: a malicious server
cannot silently promote a viewer to editor. The credential is bound to the key
epoch, so rotation invalidates the whole generation.

### 2.7 Key rotation & epoch fencing (since 0.11)

Removing a member triggers a rotation: a new root (and fresh per-space keys) is
generated, re-wrapped to the remaining members, then every document is
re-encrypted. A monotonically increasing **epoch** is committed on the server;
after the commit the server rejects any write carrying an older epoch. This
fence guarantees an in-flight old-key write cannot land after the new snapshot
and permanently poison the shared log. Rotation is idempotent and crash-safe:
nothing half-applies before the commit, and an interrupted re-encryption resumes
on restart.

### 2.8 Per-write author signatures (since 0.15–0.16)

Every write (incremental update and snapshot) in a team vault carries an
**Ed25519 author signature** over `domain ‖ kind ‖ docId ‖ epoch ‖ SHA-256(ciphertext)`
(domain `stele-update-v1`). The signature is over the *ciphertext hash*, so a
recipient verifies authorship **before decrypting**.

To verify a write, a member must know the author's trusted signing key. This is
established by a **member-certificate directory** (since 0.15): the owner
endorses each `memberId ↔ pubSign` binding with a signature over
`domain ‖ vaultId ‖ pubSign ‖ role ‖ epoch` (domain `stele-member-cert-v1`), and
any authenticated member may pull the full directory. Public signing keys are
not secret; the owner signature on each certificate is what prevents a malicious
relay from injecting a forged member. `memberId = hex(SHA-256(pubSign))`, so the
binding is self-certifying and the id is never trusted from the blob.

Verification (before `applyUpdate`): look up the author's current-epoch member
certificate → confirm role ∈ {owner, editor} → verify the write signature. A
write that fails any step is dropped and skipped via the existing poison-skip
path (re-snapshot over the offending sequence), so an injected write cannot stall
the CRDT sequence. This makes **viewer read-only enforcement client-verifiable**,
not merely server-enforced (§3.2): a viewer's write is rejected on every
recipient even if a malicious server relays it.

**Snapshots** are compaction of many members' merged operations and have no
single original author; a snapshot is signed by the compactor (an editor+ member)
as a *witness* of that state. Snapshot content authenticity therefore reduces to
"the compactor is a trusted editor," not per-operation authorship.

**Forced signing mode (since 0.16, §7.3 of the design).** During the upgrade
window, recipients tolerate *unsigned* writes (empty author) for backward
compatibility with pre-0.16 clients — a transitional gap a malicious relay could
exploit by clearing the author field on an injected write. The owner closes this
gap with a per-vault, owner-signed **policy** (`stele-vault-policy-v1`, epoch-bound,
delivered atomically with the key envelopes): once `requireSignedWrites` is set,
recipients reject all unsigned writes, and the honest server rejects them too as
defense-in-depth. The verified policy is persisted locally, so a malicious server
that later suppresses it cannot silently downgrade a client that has already seen
it. Owners should enable it after confirming every member has upgraded.

---

## 3. Trust boundaries

The single most important thing to understand about Stele's security is **which
guarantees are cryptographic (hold even against a compromised server) and which
are server-enforced (hold only if the server is honest).**

### 3.1 Cryptographic guarantees — hold against an untrusted server

| Guarantee | Mechanism |
|---|---|
| Confidentiality of content & file names | AES-256-GCM; server sees only ciphertext |
| Authenticity of key distribution | Owner Ed25519 signature on every envelope |
| Authenticity of role *assignment* | Owner-signed role credentials (§2.6) |
| Authenticity of individual writes | Per-write author signatures + member-cert directory (§2.8) |
| Forward secrecy on member removal | Key rotation + re-encryption (§2.7) |
| Per-space confidentiality | Independent per-space key, wrapped only to the access list |
| No cross-vault / cross-epoch key replay | Context binding in the envelope HKDF |

### 3.2 Server-enforced controls — NOT cryptographic

These protect against abuse and mistakes, but a **compromised server could
bypass them.** They are defense-in-depth, not end-to-end guarantees:

- **Role-based read/write enforcement.** The server rejects writes from viewers
  and drops connections of removed/demoted members. A viewer physically holds the
  team key, so a malicious server could choose to relay their writes — but since
  0.16 recipients also verify the author's role from the owner-signed member-cert
  directory (§2.8), so a viewer's (or removed member's) write is rejected
  end-to-end, not only at the server. In forced-signing mode this holds for every
  write; during the transitional window it holds for every *signed* write.
- **Kicking active connections** on removal or demotion.
- **DoS protections**: payload size caps, id validation, one-time invite tokens,
  rate-relevant limits.
- **Membership list.** The server knows who is in a vault (this is metadata it
  necessarily sees).

The design deliberately draws the line here. E2EE's hardest problem —
decentralized group key distribution and post-removal rotation — is made
tractable precisely because the always-online relay handles *routing* of already
end-to-end-encrypted key envelopes, while never being trusted with their
plaintext.

---

## 4. Known limitations

We document these explicitly rather than let them be assumed away.

### 4.1 Write authenticity: implemented, with bounded residuals

Individual writes are now author-signed and verified end-to-end (§2.8), which
closes the former largest open item. What remains bounded:

- **Legitimate editors are not content-audited.** A member with a legitimate
  editor/owner role holds the key and can write any content; the signature proves
  *who* wrote it (attribution), not that the content is *desired*. This is an
  audit-and-social matter by design, not something cryptography prevents.
- **Transitional tolerance until forced mode.** For backward compatibility,
  recipients tolerate unsigned writes until the owner enables forced signing
  (§2.8). Within that window a malicious relay could inject an unsigned write with
  a cleared author field. Enabling `requireSignedWrites` closes it; the verified
  policy is persisted locally to resist later suppression by a malicious server.
- **Availability is still not guaranteed.** A malicious server cannot forge or
  read content, but it can still suppress, delay, or reorder delivery. Signatures
  provide authenticity and integrity, not availability.
- **Fine-grained (per-character) blame is out of scope.** Authorship is verified
  at the write level; mapping individual CRDT operations back to authors after
  merge/compaction is deliberately not attempted.

### 4.2 Restriction is forward-only

Making an *existing* space restricted only protects content produced
**afterward**. Anything synced before the restriction is already a plaintext copy
(and old ciphertext) on the devices of members who had access. On restriction,
Stele moves such notes to the trash on now-unauthorized devices as an honest UI
signal, but this cannot recall data already on disk. **To keep something secret,
create the restricted space first, then put content into it.**

### 4.3 Same-epoch role credential replay

Within a single key epoch, if the owner changes a member's role, a malicious
server could replay the *previous* (still owner-signed, same-epoch) credential.
Both are genuine owner signatures, so the member cannot distinguish them. Rotating
the key flushes the entire credential generation and is the owner's remedy.
Cross-epoch replay is already prevented (credentials are epoch-bound).

### 4.4 Device and at-rest security

A trusted device is assumed. On an unlocked, compromised device, decrypted
content, the vault key in memory, and the plaintext `.md` mirror are all
exposed. The identity seed is protected at rest by the OS keychain; the personal
vault key is passphrase-derived and never stored. Stele does not defend against a
fully compromised endpoint.

### 4.5 Metadata visible to the server

Even as a blind relay, the server observes: vault membership, opaque document
ids, update sizes, and sync timing. It does not see plaintext, file names, or
folder structure. Traffic-analysis resistance is out of scope.

---

## 5. Supported versions

Security fixes target the latest released version. Given the pre-1.0 status,
users should stay current; there is no long-term-support branch yet.

## 6. Reporting

Email `security@cluion.com`. Please allow a reasonable disclosure window before
going public. We credit reporters unless they prefer to remain anonymous.
