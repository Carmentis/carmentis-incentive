export function info(msg: string) {
    format("INFO", msg);
}
export function warn(msg: string) {
    format("WARN", msg);
}
export function error(msg: string) {
    format("ERROR", msg);
}
function format(type: string, msg: string) {
    const d = new Date();
    console.log(`[${d.toISOString().slice(0, -5)}] ${type} - ${msg}`);
}
