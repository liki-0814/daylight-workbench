import { signCosy } from "./cosy.js";
import { loadProfileForAccount, renderHeaderTemplates } from "./profile.js";
export function sessionFromAccount(config, account) {
    const c = account.credential;
    const profile = loadProfileForAccount(config, account);
    return {
        uid: c.uid,
        accessToken: c.access,
        machineId: c.machineId,
        machineToken: profile.tokenModel === "single" ? c.access : c.machineToken,
        cosyVersion: profile.cosyVersion,
        clientVersion: profile.clientVersion,
        organizationId: c.organizationId,
        organizationTags: c.organizationTags,
        dataPolicy: c.dataPolicy,
        profile
    };
}
function splitTags(tags) {
    return tags ? tags.split(",").filter((t)=>t.trim() !== "") : [];
}
function identityOf(session) {
    const inPayload = new Set(session.profile.infoPayload);
    const identity = {
        uid: session.uid,
        securityOauthToken: inPayload.has("security_oauth_token") ? session.accessToken : undefined,
        cosyVersion: session.cosyVersion
    };
    const extra = {};
    if (inPayload.has("organization_id")) extra.organization_id = session.organizationId ?? "";
    if (inPayload.has("organization_tags")) extra.organization_tags = splitTags(session.organizationTags);
    if (inPayload.has("data_policy_agreed")) {
        extra.data_policy_agreed = (session.dataPolicy ?? "").toUpperCase() === "AGREE";
    }
    if (Object.keys(extra).length > 0) identity.extraUserInfo = extra;
    return identity;
}
function signingHeaders(session, sig) {
    const inPayload = new Set(session.profile.infoPayload);
    const headers = {
        authorization: sig.authorization,
        "cosy-user": session.uid,
        "cosy-key": sig.cosyKey,
        "cosy-date": sig.cosyDate,
        "cosy-machineid": session.machineId,
        "cosy-machinetoken": session.machineToken,
        "cosy-version": session.cosyVersion,
        "login-version": "v2"
    };
    if (!inPayload.has("organization_id") && session.organizationId) {
        headers["cosy-organization-id"] = session.organizationId;
    }
    if (!inPayload.has("organization_tags") && session.organizationTags) {
        headers["cosy-organization-tags"] = session.organizationTags;
    }
    if (!inPayload.has("data_policy_agreed") && session.dataPolicy) {
        headers["cosy-data-policy"] = session.dataPolicy;
    }
    return headers;
}
function baseCosyHeaders(session, sig) {
    return {
        ...renderHeaderTemplates(session.profile.headerGroups.base ?? {}, {}),
        ...signingHeaders(session, sig)
    };
}
function inferenceHeaders(session, sig, modelKey) {
    return {
        ...signingHeaders(session, sig),
        ...renderHeaderTemplates(session.profile.headerGroups.inference ?? {}, {
            modelKey,
            modelSource: "system"
        })
    };
}
export class QoderHttp {
    config;
    fetchImpl;
    constructor(config, fetchImpl = fetch){
        this.config = config;
        this.fetchImpl = fetchImpl;
    }
    openapiUrl(pathname) {
        return new URL(pathname, this.config.openapiUrl).toString();
    }
    algoUrl(pathname) {
        return new URL(pathname, this.config.compatUrl).toString();
    }
    centerUrl(pathname) {
        return new URL(pathname, this.config.centerUrl).toString();
    }
    async requestUrl(method, fullUrl, opts = {}) {
        const headers = {
            ...opts.headers ?? {}
        };
        let body;
        if (opts.body !== undefined) {
            body = JSON.stringify(opts.body);
            if (!Object.keys(headers).some((k)=>k.toLowerCase() === "content-type")) {
                headers["content-type"] = "application/json";
            }
        }
        return this.fetchImpl(fullUrl, {
            method,
            headers,
            body,
            signal: opts.signal
        });
    }
    async openapi(method, pathname, req) {
        const url = new URL(pathname, this.config.openapiUrl);
        if (req.query) {
            for (const [k, v] of Object.entries(req.query)){
                if (v !== undefined) url.searchParams.set(k, String(v));
            }
        }
        const headers = {
            authorization: `Bearer ${req.token}`,
            accept: "application/json",
            ...req.headers
        };
        let body;
        if (req.body !== undefined) {
            body = JSON.stringify(req.body);
            headers["content-type"] = "application/json";
        }
        return this.fetchImpl(url.toString(), {
            method,
            headers,
            body,
            signal: req.signal
        });
    }
    async signedGet(fullUrl, session, opts = {}) {
        const sig = signCosy({
            url: fullUrl,
            body: "",
            identity: identityOf(session),
            temporaryKey: opts.temporaryKey,
            timestamp: opts.timestamp
        });
        return this.fetchImpl(fullUrl, {
            method: "GET",
            headers: {
                ...baseCosyHeaders(session, sig),
                accept: "application/json"
            },
            signal: opts.signal
        });
    }
    async signedInference(fullUrl, req) {
        const sig = signCosy({
            url: fullUrl,
            body: req.encodedBody,
            identity: identityOf(req.session),
            temporaryKey: req.temporaryKey,
            requestId: req.requestId,
            timestamp: req.timestamp
        });
        return this.fetchImpl(fullUrl, {
            method: "POST",
            headers: inferenceHeaders(req.session, sig, req.modelKey),
            body: req.encodedBody,
            signal: req.signal
        });
    }
}
export { baseCosyHeaders, inferenceHeaders };
