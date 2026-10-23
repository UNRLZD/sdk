/**
 * A new device key for a server (sdk.md "The key on a server"): keep `secretKey` in your env or secret store and give
 * the owner `publicKey` to add from their wallet.
 *
 *   node src/keygen.ts
 */
import { newDeviceKey } from "./lib.ts";

const k = await newDeviceKey();
console.log(`secretKey ${k.secretKey}\npublicKey ${k.publicKey}`);
