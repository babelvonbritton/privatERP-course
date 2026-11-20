import { version } from "../../package.json";

/** Build-time identity of the app, written into backup manifests and shown in the footer and settings. */
export const APP_NAME = "Olaseena";
/** Comes from package.json, the only place the version is set. */
export const APP_VERSION: string = version;
