export interface SafeTransportStatus {httpStatus?:number;code?:string;retryAfterMs?:number;}
export const STATUS_PREFIX:string;
export function safeTransportStatus(value?:unknown):SafeTransportStatus;
export function transportStatusFromHeaders(headers?:Record<string,unknown>,now?:number):SafeTransportStatus;
export function transportStatusError(value:unknown):string|undefined;
