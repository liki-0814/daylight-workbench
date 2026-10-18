// Only locally authored messages and known error codes may cross this boundary.
// Upstream bodies, arbitrary exception messages and URLs can contain credentials.
export function operationError(error,fallback='操作失败，请检查对应来源的登录状态、网络或本地配置'){
 const code=error?.cause?.code||error?.code;
 if(['UNABLE_TO_GET_ISSUER_CERT_LOCALLY','UNABLE_TO_VERIFY_LEAF_SIGNATURE','SELF_SIGNED_CERT_IN_CHAIN','DEPTH_ZERO_SELF_SIGNED_CERT','CERT_HAS_EXPIRED','ERR_TLS_CERT_ALTNAME_INVALID'].includes(code))return '安全连接失败：TLS 证书校验未通过，请检查系统信任证书、网络代理或 Node 版本；无需退出账号';
 if(['EKEYCHAIN_INTERACTION_REQUIRED','EKEYCHAIN_AUTH_FAILED','EKEYCHAIN_TIMEOUT','EKEYCHAIN_UNAVAILABLE','EAGY_OAUTH_CLIENT_CONFIG','EAGY_ONBOARDING'].includes(code))return error.message;
 if(error?.name==='TimeoutError'||['ETIMEDOUT','UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT'].includes(code))return '连接来源服务超时，请检查系统代理与网络后重试';
 if(['ECONNREFUSED','ECONNRESET','ENOTFOUND','EAI_AGAIN','ENETUNREACH','EHOSTUNREACH'].includes(code))return '无法连接来源服务，请检查系统代理是否运行、网络和 DNS 后重试';
 return error?.status?error.message:fallback;
}
