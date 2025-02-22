export const PLATFORM_NAME = 'OpenSpa';
export const PLUGIN_NAME = 'homebridge-openspa';

export type SystemType = 'sauna' | 'steam' | 'fan' | 'light';

export interface OpenSpaConfig {
  manufacturer: string; // Name of the manufacturer
  platform: string; // Name of the platform
  name: string; // Custom name for the sauna system
  serial: string; // Custom serial for the sauna system
  hasSauna: boolean; // Indicates if the sauna is present
  hasSteam: boolean; // Indicates if the steam room is present
  hasLight: boolean; // Indicates if a light control is available
  hasFan: boolean; // Indicates if a fan control is available
  saunaDoorNO: boolean; // Magnetic Switch Type: true for (NO) Normally-Open, false for (NC) Normally-Closed
  steamDoorNO: boolean; // Magnetic Switch Type: true for (NO) Normally-Open, false for (NC) Normally-Closed
  gpioPowerPins: powerPin[]; // Controller specific relays for actuating 120V relays.
  relayPins: relayPin[]; // System to GPIO associations
  thermistors: thermistorConfig[]; // Configuration of auxiliary sensors
  saunaDoorPin: number;
  saunaOnWhileDoorOpen: boolean; // Allows the sauna to be on while the door is open
  steamDoorPin: number;
  steamOnWhileDoorOpen: boolean; // Allows the steam room to be on while the door is open
  saunaTimeout: number; // Maximum runtime for the sauna in minutes before auto-shutdown
  steamTimeout: number; // Maximum runtime for the steam room in minutes before auto-shutdown
  controllerSafetyTemperature: number; // Safety limit for the controller board temperature in degrees (hard-coded)
  saunaMaxTemperature: number; // Maximum user-configurable temperature for the sauna in degrees
  saunaSafetyTemperature: number; // Safety limit for sauna temperature in degrees (hard-coded)
  steamMaxTemperature: number; // Maximum user-configurable temperature for the steam room in degrees
  steamSafetyTemperature: number; // Safety limit for steam room temperature in degrees (hard-coded)
}

export interface powerPin {
  set: number; // relay GPIO pin for set
  reset: number; // relay GPIO pin for reset
}

export interface relayPin {
  GPIO: number[]; // GPIO pins for power control
  system: SystemType; // System type associated with these power pins
}

export interface thermistorConfig {
  name: string; // Name of the auxiliary sensor
  channel: number; // ADC channel number associated with the sensor
  system: 'sauna' | 'steam' | 'controller' | null; // The sensor to system association, or null if not associated
  control: boolean; // Whether the sensor affects control logic (e.g., turns off power if overheating)
  resistanceAt25C: number; // NTC resistance in Ohms @ 25°C
  bValue: number; // NTC beta value
}
