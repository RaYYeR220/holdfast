import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createKeyPairSignerFromBytes, generateKeyPair, type KeyPairSigner } from '@solana/kit';

/** A keypair in the 64-byte form the Solana CLI reads: seed followed by public key. */
type SecretKey = number[];

interface KeyFile {
  note: string;
  owner: SecretKey;
  delegate: SecretKey;
  mint: SecretKey;
  recipients: SecretKey[];
}

export interface ProofKeys {
  owner: KeyPairSigner;
  delegate: KeyPairSigner;
  delegateSecretKey: Uint8Array;
  mint: KeyPairSigner;
  recipients: KeyPairSigner[];
}

async function generateSecretKey(): Promise<SecretKey> {
  const pair = await generateKeyPair(true);
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  // The seed is the last 32 bytes of an Ed25519 PKCS#8 document.
  return [...pkcs8.subarray(pkcs8.length - 32), ...publicKey];
}

const toSigner = (secretKey: SecretKey): Promise<KeyPairSigner> =>
  createKeyPairSignerFromBytes(new Uint8Array(secretKey));

/**
 * The owner and the delegate are kept between runs so they only need funding
 * once. The mint and the recipients are new every time, which gives each run
 * a token account history of its own.
 */
export async function loadOrCreateKeys(file: string, recipientCount: number): Promise<ProofKeys> {
  const previous = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Partial<KeyFile>) : {};
  const keys: KeyFile = {
    note: 'Throwaway keys for the devnet proof. Never fund them on mainnet.',
    owner: previous.owner ?? (await generateSecretKey()),
    delegate: previous.delegate ?? (await generateSecretKey()),
    mint: await generateSecretKey(),
    recipients: await Promise.all(Array.from({ length: recipientCount }, generateSecretKey)),
  };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(keys)}\n`);
  return {
    owner: await toSigner(keys.owner),
    delegate: await toSigner(keys.delegate),
    delegateSecretKey: new Uint8Array(keys.delegate),
    mint: await toSigner(keys.mint),
    recipients: await Promise.all(keys.recipients.map(toSigner)),
  };
}
