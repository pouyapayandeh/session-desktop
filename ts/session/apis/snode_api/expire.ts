import { isEmpty, slice } from 'lodash';
import { Snode } from '../../../data/data';
import { getSodiumRenderer } from '../../crypto';
import { DEFAULT_CONNECTIONS } from '../../sending/MessageSender';
import { PubKey } from '../../types';
import { StringUtils, UserUtils } from '../../utils';
import { EmptySwarmError } from '../../utils/errors';
import { firstTrue } from '../../utils/Promise';
import { fromBase64ToArray, fromHexToArray, fromUInt8ArrayToBase64 } from '../../utils/String';
import { snodeRpc } from './sessionRpc';
import { getNowWithNetworkOffset } from './SNodeAPI';
import { getSwarmFor } from './snodePool';

async function generateSignature({
  pubkey_ed25519,
  shortenOrExtend,
  timestamp,
  messageHashes,
}: {
  pubkey_ed25519: UserUtils.HexKeyPair;
  shortenOrExtend: string;
  timestamp: number;
  messageHashes: Array<string>;
}): Promise<{ signature: string; pubkey_ed25519: string } | null> {
  if (!pubkey_ed25519) {
    return null;
  }

  const edKeyPrivBytes = fromHexToArray(pubkey_ed25519?.privKey);

  // "expire" || ShortenOrExtend || expiry || messages[0] || ... || messages[N]
  const verificationString = `expire${shortenOrExtend}${timestamp}${messageHashes.join('')}`;
  const verificationData = StringUtils.encode(verificationString, 'utf8');
  window.log.debug(`generateSignature verificationString ${verificationString}`);
  const message = new Uint8Array(verificationData);

  const sodium = await getSodiumRenderer();
  try {
    const signature = sodium.crypto_sign_detached(message, edKeyPrivBytes);
    const signatureBase64 = fromUInt8ArrayToBase64(signature);

    return {
      signature: signatureBase64,
      pubkey_ed25519: pubkey_ed25519.pubKey,
    };
  } catch (e) {
    window.log.warn('generateSignature failed with: ', e.message);
    return null;
  }
}

async function verifySignature({
  pubkey,
  snodePubkey,
  expiryApplied,
  signature,
  messageHashes,
  updatedHashes,
  unchangedHashes,
}: {
  pubkey: PubKey;
  snodePubkey: any;
  expiryApplied: number;
  signature: string;
  messageHashes: Array<string>;
  updatedHashes: Array<string>;
  // only used when shorten or extend is in the request
  unchangedHashes?: Record<string, string>;
}): Promise<boolean> {
  if (!expiryApplied || isEmpty(messageHashes) || isEmpty(signature)) {
    window.log.warn('verifySignature missing argument');
    return false;
  }

  const edKeyPrivBytes = fromHexToArray(snodePubkey);
  /* PUBKEY_HEX || EXPIRY || RMSGs... || UMSGs... || CMSG_EXPs...
  where RMSGs are the requested expiry hashes,
  UMSGs are the actual updated hashes, and
  CMSG_EXPs are (HASH || EXPIRY) values, ascii-sorted by hash, for the unchanged message hashes included in the "unchanged" field.
  */
  const hashes = [...messageHashes, ...updatedHashes];
  if (unchangedHashes && Object.keys(unchangedHashes).length > 0) {
    hashes.push(
      ...Object.entries(unchangedHashes)
        .map(([key, value]: [string, string]) => {
          return `${key}${value}`;
        })
        .sort()
    );
  }

  const verificationString = `${pubkey.key}${expiryApplied}${hashes.join('')}`;
  const verificationData = StringUtils.encode(verificationString, 'utf8');
  window.log.debug(`verifySignature verificationString`, verificationString);

  const sodium = await getSodiumRenderer();
  try {
    const isValid = sodium.crypto_sign_verify_detached(
      fromBase64ToArray(signature),
      new Uint8Array(verificationData),
      edKeyPrivBytes
    );

    return isValid;
  } catch (e) {
    window.log.warn('verifySignature failed with: ', e.message);
    return false;
  }
}

async function processExpirationResults(
  pubkey: PubKey,
  targetNode: Snode,
  swarm: Record<string, any>,
  messageHashes: Array<string>
) {
  if (isEmpty(swarm)) {
    throw Error(`expireOnNodes failed! ${messageHashes}`);
  }

  // TODO need proper typing for swarm and results
  const results: Record<string, { hashes: Array<string>; expiry: number }> = {};
  // window.log.debug(`processExpirationResults start`, swarm, messageHashes);

  for (const nodeKey of Object.keys(swarm)) {
    if (!isEmpty(swarm[nodeKey].failed)) {
      const reason = 'Unknown';
      const statusCode = '404';
      window?.log?.warn(
        `loki_message:::expireMessage - Couldn't delete data from: ${
          targetNode.pubkey_ed25519
        }${reason && statusCode && ` due to an error ${reason} (${statusCode})`}`
      );
      // TODO This might be a redundant step
      results[nodeKey] = { hashes: [], expiry: 0 };
    }

    const updatedHashes = swarm[nodeKey].updated;
    const unchangedHashes = swarm[nodeKey].unchanged;
    const expiryApplied = swarm[nodeKey].expiry;
    const signature = swarm[nodeKey].signature;

    const isValid = await verifySignature({
      pubkey,
      snodePubkey: nodeKey,
      expiryApplied,
      signature,
      messageHashes,
      updatedHashes,
      unchangedHashes,
    });

    if (!isValid) {
      window.log.warn(
        'loki_message:::expireMessage - Signature verification failed!',
        messageHashes
      );
    }
    results[nodeKey] = { hashes: updatedHashes, expiry: expiryApplied };
  }

  return results;
}

type ExpireParams = {
  pubkey: PubKey;
  messages: Array<string>;
  expiry: number;
  signature: string;
};

async function expireOnNodes(targetNode: Snode, params: ExpireParams) {
  // THE RPC requires the pubkey to be a string but we need the Pubkey for signature processing.
  const rpcParams = { ...params, pubkey: params.pubkey.key };
  try {
    const result = await snodeRpc({
      method: 'expire',
      params: rpcParams,
      targetNode,
      associatedWith: params.pubkey.key,
    });

    if (!result || result.status !== 200 || !result.body) {
      return false;
    }

    try {
      const parsed = JSON.parse(result.body);
      const expirationResults = await processExpirationResults(
        params.pubkey,
        targetNode,
        parsed.swarm,
        params.messages
      );
      window.log.debug(`expireOnNodes attempt complete. Here are the results`, expirationResults);

      return true;
    } catch (e) {
      window?.log?.warn('expireOnNodes Failed to parse "swarm" result: ', e.msg);
    }
    return false;
  } catch (e) {
    window?.log?.warn('expire - send error:', e, `destination ${targetNode.ip}:${targetNode.port}`);
    throw e;
  }
}

type ExpireMessageOnSnodeProps = {
  messageHash: string;
  expireTimer: number;
  extend?: boolean;
  shorten?: boolean;
};

export async function expireMessageOnSnode(props: ExpireMessageOnSnodeProps) {
  const { messageHash, expireTimer, extend, shorten } = props;

  if (extend && shorten) {
    window.log.error(
      '[expireMessageOnSnode] We cannot extend and shorten a message at the same time',
      messageHash
    );
    return;
  }

  const shortenOrExtend = shorten ? 'shorten' : extend ? 'extend' : '';

  const ourPubKey = UserUtils.getOurPubKeyFromCache();
  const ourEd25519Key = await UserUtils.getUserED25519KeyPair();

  if (!ourPubKey || !ourEd25519Key) {
    window.log.eror('[expireMessageOnSnode] No pubkey found', messageHash);
    return;
  }

  const swarm = await getSwarmFor(ourPubKey.key);

  const expiry = getNowWithNetworkOffset() + expireTimer;
  const signResult = await generateSignature({
    pubkey_ed25519: ourEd25519Key,
    shortenOrExtend,
    timestamp: expiry,
    messageHashes: [messageHash],
  });

  if (!signResult) {
    window.log.error('[expireMessageOnSnode] Signing message expiry on swarm failed', messageHash);
    return;
  }

  const params = {
    pubkey: ourPubKey,
    pubkey_ed25519: ourEd25519Key.pubKey.toUpperCase(),
    // TODO better testing for failed case
    // messages: ['WabEZS4RH/NrDhm8vh1gXK4xSmyJL1d4BUC/Ho6GRxA'],
    messages: [messageHash],
    expiry,
    extend: extend || undefined,
    shorten: shorten || undefined,
    signature: signResult?.signature,
  };

  const usedNodes = slice(swarm, 0, DEFAULT_CONNECTIONS);
  if (!usedNodes || usedNodes.length === 0) {
    throw new EmptySwarmError(ourPubKey.key, 'Ran out of swarm nodes to query');
  }

  const promises = usedNodes.map(async usedNode => {
    const successfulSend = await expireOnNodes(usedNode, params);
    if (successfulSend) {
      return usedNode;
    }
    return undefined;
  });

  let snode: Snode | undefined;
  try {
    const firstSuccessSnode = await firstTrue(promises);
    snode = firstSuccessSnode;
  } catch (e) {
    const snodeStr = snode ? `${snode.ip}:${snode.port}` : 'null';
    window?.log?.warn(
      `loki_message:::expireMessage - ${e.code ? `${e.code} ` : ''}${e.message} by ${
        ourPubKey.key
      } for ${messageHash} via snode:${snodeStr}`
    );
    throw e;
  }
}
