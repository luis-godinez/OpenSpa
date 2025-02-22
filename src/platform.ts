import {
  API,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  PlatformConfig,
  Service,
  Characteristic,
} from 'homebridge';
import { PLATFORM_NAME, PLUGIN_NAME, OpenSpaConfig } from './settings.js';
import { OpenSpaAccessory } from './platformAccessory.js';

export class OpenSpaPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;
  public readonly accessories: PlatformAccessory[] = [];

  constructor(public readonly log: Logger, public readonly config: PlatformConfig, public readonly api: API) {
    this.Service = this.api.hap.Service;
    this.Characteristic = this.api.hap.Characteristic;

    this.api.on('didFinishLaunching', () => {
      this.log.info('OpenSpa Plugin finished launching');
      this.discoverDevices();
    });
  }

  configureAccessory(accessory: PlatformAccessory) {
    this.accessories.push(accessory);
  }

  discoverDevices() {
    this.log.info('Starting device discovery...');

    // Cast config to OpenSpaConfig
    const devices = this.config as OpenSpaConfig;

    if (!this.isOpenSpaConfig(devices)) {
      this.log.error('Invalid configuration for OpenSpa. Please check your config.json.');
      return;
    }

    this.log.info('Configuration validated, setting up devices...');

    // Set default values for new settings if not provided
    devices.saunaOnWhileDoorOpen = devices.saunaOnWhileDoorOpen ?? true;
    devices.steamOnWhileDoorOpen = devices.steamOnWhileDoorOpen ?? true;
    devices.saunaTimeout = devices.saunaTimeout ?? 60; // in minutes
    devices.steamTimeout = devices.steamTimeout ?? 60; // in minutes
    devices.saunaMaxTemperature = devices.saunaMaxTemperature ?? 100;
    devices.steamMaxTemperature = devices.steamMaxTemperature ?? 60;
    devices.saunaSafetyTemperature = devices.saunaSafetyTemperature ?? 120;
    devices.steamSafetyTemperature = devices.steamSafetyTemperature ?? 60;
    devices.controllerSafetyTemperature =
      devices.controllerSafetyTemperature ?? 90;

    this.log.info('Defaults applied, adding accessory...');
    this.addAccessory(devices);
    this.log.info('Device discovery completed.');
  }

  private addAccessory(devices: OpenSpaConfig) {
    // Generate a unique UUID for the combined accessory
    const uuid = this.api.hap.uuid.generate(devices.name);

    // Find existing accessory by UUID
    const existingAccessory = this.accessories.find((accessory) => accessory.UUID === uuid);

    if (existingAccessory) {
      // The accessory already exists, update it
      this.log.info('Restoring existing accessory from cache:', existingAccessory.displayName);

      // Update the existing accessory's information and services
      new OpenSpaAccessory(this, existingAccessory, devices);

      // Ensure the accessory is up-to-date
      this.api.updatePlatformAccessories([existingAccessory]);
    } else {
      // Create a new accessory
      this.log.info('Adding new accessory:', devices.name);
      const accessory = new this.api.platformAccessory(devices.name, uuid);

      // Create the accessory handler
      new OpenSpaAccessory(this, accessory, devices);

      // Register the new accessory
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);

      // Add to the accessory cache
      this.accessories.push(accessory);
    }
  }

  private isOpenSpaConfig(config: any): config is OpenSpaConfig {
    // Check if config is an object and if it has the required properties
    if (typeof config !== 'object' || config === null) {
      return false;
    }

    // Validate the presence of required properties
    const requiredKeys: Array<keyof OpenSpaConfig> = [
      'manufacturer',
      'platform',
      'name',
      'serial',
      'hasSauna',
      'hasSteam',
      'hasLight',
      'hasFan',
      'saunaDoorNO',
      'steamDoorNO',
      'gpioPowerPins',
      'relayPins',
      'thermistors',
      'saunaDoorPin',
      'saunaOnWhileDoorOpen',
      'steamDoorPin',
      'steamOnWhileDoorOpen',
      'saunaTimeout',
      'steamTimeout',
      'controllerSafetyTemperature',
      'saunaMaxTemperature',
      'saunaSafetyTemperature',
      'steamMaxTemperature',
      'steamSafetyTemperature',
    ];

    // Validate that all required keys are present
    for (const key of requiredKeys) {
      this.log.info('validating key:', key);
      if (!(key in config)) {
        this.log.warn(key, 'missing from config.');
        return false;
      }
    }

    // Further validation can be done if necessary, but if all keys exist, it's likely valid
    return true;
  }
}
