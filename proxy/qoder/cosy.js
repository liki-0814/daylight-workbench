import * as crypto from "node:crypto";
import { randomHex, uuid } from "../shared/utils.js";
export const RSA_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----`;
export function rsaEncryptPkcs1(plaintext) {
    const encrypted = crypto.publicEncrypt({
        key: RSA_PUBLIC_KEY,
        padding: crypto.constants.RSA_PKCS1_PADDING
    }, Buffer.from(plaintext, "utf8"));
    return encrypted.toString("base64");
}
function pkcs7Pad(data, blockSize = 16) {
    const padLen = blockSize - data.length % blockSize;
    const pad = Buffer.alloc(padLen, padLen);
    return Buffer.concat([
        data,
        pad
    ]);
}
export function aesEncryptInfo(userInfoJson, temporaryKey) {
    const key = Buffer.from(temporaryKey, "utf8");
    if (key.length !== 16) {
        throw new Error(`temporaryKey must be 16 bytes for AES-128, got ${key.length}`);
    }
    const cipher = crypto.createCipheriv("aes-128-cbc", key, key);
    cipher.setAutoPadding(false);
    const padded = pkcs7Pad(Buffer.from(userInfoJson, "utf8"));
    const enc = Buffer.concat([
        cipher.update(padded),
        cipher.final()
    ]);
    return enc.toString("base64");
}
export function aesDecryptInfo(infoB64, temporaryKey) {
    const key = Buffer.from(temporaryKey, "utf8");
    const decipher = crypto.createDecipheriv("aes-128-cbc", key, key);
    decipher.setAutoPadding(false);
    const dec = Buffer.concat([
        decipher.update(Buffer.from(infoB64, "base64")),
        decipher.final()
    ]);
    const padLen = dec[dec.length - 1] ?? 0;
    return dec.subarray(0, dec.length - padLen).toString("utf8");
}
export function signedPathOf(url) {
    const u = new URL(url);
    let path = u.pathname;
    if (path.startsWith("/algo")) path = path.slice("/algo".length);
    if (path === "") path = "/";
    return path;
}
export function signCosy(input) {
    const temporaryKey = input.temporaryKey ?? randomHex(8);
    const requestId = input.requestId ?? uuid();
    const timestamp = input.timestamp ?? Math.floor(Date.now() / 1000);
    const userInfo = {
        uid: input.identity.uid
    };
    if (input.identity.securityOauthToken !== undefined) {
        userInfo.security_oauth_token = input.identity.securityOauthToken;
    }
    Object.assign(userInfo, input.identity.extraUserInfo);
    const cosyKey = rsaEncryptPkcs1(temporaryKey);
    const info = aesEncryptInfo(JSON.stringify(userInfo), temporaryKey);
    const payloadObj = {
        version: "v1",
        requestId,
        info,
        cosyVersion: input.identity.cosyVersion,
        ideVersion: ""
    };
    const payload = Buffer.from(JSON.stringify(payloadObj), "utf8").toString("base64");
    const signedPath = signedPathOf(input.url);
    const timestampStr = String(timestamp);
    const signingString = `${payload}\n${cosyKey}\n${timestampStr}\n${input.body}\n${signedPath}`;
    const signature = crypto.createHash("md5").update(signingString, "utf8").digest("hex");
    return {
        authorization: `Bearer COSY.${payload}.${signature}`,
        cosyKey,
        cosyDate: timestampStr,
        cosyUser: input.identity.uid,
        payload,
        signature,
        signedPath,
        temporaryKey,
        requestId
    };
}
