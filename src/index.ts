import type { API } from 'homebridge';
import { PLATFORM_NAME, PLUGIN_NAME, XiaomiVacuumMatterPlatform } from './platform.js';

export default (api: API): void => {
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, XiaomiVacuumMatterPlatform);
};
