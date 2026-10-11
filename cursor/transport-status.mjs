// Safe metadata side channel. Protobuf stdout stays byte-for-byte compatible with
// already-loaded consumers; never serialize headers, tokens, response bodies or prompts.
export const STATUS_PREFIX='[cursor-bridge-status]';
const codes=['ok','cancelled','unknown','invalid_argument','deadline_exceeded','not_found','already_exists','permission_denied','resource_exhausted','failed_precondition','aborted','out_of_range','unimplemented','internal','unavailable','data_loss','unauthenticated'];
export function safeTransportStatus(value={}) {
  const out={};if(!value||typeof value!=='object')return out;
  if(Number.isInteger(value.httpStatus)&&value.httpStatus>=100&&value.httpStatus<=599)out.httpStatus=value.httpStatus;
  const numeric=typeof value.code==='number'?value.code:typeof value.code==='string'&&/^\d{1,2}$/.test(value.code)?Number(value.code):undefined;
  const code=numeric===undefined?value.code:codes[numeric];
  if(codes.includes(code))out.code=code;
  if(Number.isFinite(value.retryAfterMs)&&value.retryAfterMs>=0)out.retryAfterMs=Math.min(86_400_000,Math.ceil(value.retryAfterMs));
  return out;
}
export function transportStatusFromHeaders(headers={},now=Date.now()) {
  const retry=headers['retry-after'];
  const retryAfterMs=typeof retry==='string'?/^\d+(?:\.\d+)?$/.test(retry)?Number(retry)*1000:Math.max(0,Date.parse(retry)-now):undefined;
  return safeTransportStatus({httpStatus:headers[':status'],code:headers['grpc-status']??headers['connect-error-code'],retryAfterMs});
}
export function transportStatusError(value) {
  const status=safeTransportStatus(value);
  if(status.httpStatus===401||status.code==='unauthenticated')return `Cursor authentication error: unauthenticated${status.httpStatus===401?' (HTTP 401)':''}`;
  if(status.httpStatus===429||status.code==='resource_exhausted')return `Cursor rate limit: resource_exhausted${status.httpStatus===429?' (HTTP 429)':''}`;
  if(status.httpStatus===404||status.code==='not_found')return 'Cursor model not found: not_found';
  if(status.httpStatus===403||status.code==='permission_denied')return `Cursor permission denied${status.httpStatus===403?' (HTTP 403)':''}`;
  if((status.httpStatus??0)>=500 || ['unknown','deadline_exceeded','aborted','internal','unavailable','data_loss'].includes(status.code))
    return `Cursor connection error: ${status.code??'upstream_error'}${status.httpStatus?` (HTTP ${status.httpStatus})`:''}`;
  if((status.httpStatus??0)>=400||['cancelled','invalid_argument','already_exists','failed_precondition','out_of_range','unimplemented'].includes(status.code))
    return `Cursor request rejected: ${status.code??'upstream_error'}${status.httpStatus?` (HTTP ${status.httpStatus})`:''}`;
  return undefined;
}
