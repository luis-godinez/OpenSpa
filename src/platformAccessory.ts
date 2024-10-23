// platformAccessory.ts

import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';
import { OpenSpaPlatform } from './platform.js';
import { Gpio } from 'onoff';
import { openMcp3008, McpInterface, McpReading, EightChannels } from 'mcp-spi-adc';
import { OpenSpaConfig, thermistorConfig, SystemType } from './settings.js';

export class OpenSpaAccessory {
  private temperatureSensors: Map<string, Service> = new Map();
  private lightPowerSwitch?: Service;
  private fanPowerSwitch?: Service;
  private saunaTimer: NodeJS.Timeout | null = null;
  private steamTimer: NodeJS.Timeout | null = null;
  private doorPollRegistered: { [pin: number]: boolean } = {};
  private relaysEnabled = false;

  constructor(
    private readonly platform: OpenSpaPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly config: OpenSpaConfig,
  ) {
    this.accessory
      .getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Ungodly Design')
      .setCharacteristic(this.platform.Characteristic.Name, 'OpenSpa')
      .setCharacteristic(this.platform.Characteristic.Model, 'v1.0')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, `${this.config.serial}`);

    // Initialize peripherals with error handling and timeouts
    this.initializePeripherals()
      .then(() => {
        this.setupAccessory();
      })
      .catch((error) => {
        this.platform.log.error('Initialization failed:', error);
        this.cleanupGPIO(); // Ensure GPIO pins are cleaned up on error
      });

    process.on('exit', this.cleanupGPIO.bind(this));
    process.on('SIGINT', () => {
      this.cleanupGPIO();
      process.exit();
    });
    process.on('SIGTERM', () => {
      this.cleanupGPIO();
      process.exit();
    });

    process.on('uncaughtException', (err) => {
      this.platform.log.error('Uncaught Exception:', err);
      this.cleanupGPIO(); // Ensure GPIO pins are cleaned up on error
      process.exit(1);
    });

    process.on('unhandledRejection', (reason, p) => {
      this.platform.log.error('Unhandled Rejection at:', p, 'reason:', reason);
      this.cleanupGPIO(); // Ensure GPIO pins are cleaned up on error
      process.exit(1);
    });
  }

  // Initialize all hardware peripherals asynchronously with error handling
  private async initializePeripherals() {
    this.platform.log.info('Starting peripheral initialization...');

    try {
      this.validateSensorConfiguration();

      await Promise.all([this.initializeGPIOAsync()]);

      this.platform.log.info('Peripheral initialization completed.');
    } catch (error) {
      this.platform.log.error('Peripheral initialization failed:', error);
      throw error;
    }
  }

  private validateSensorConfiguration() {
    const systemCount: { [key: string]: number } = {};

    this.config.thermistors.forEach((sensor) => {
      if (sensor.system) {
        if (!systemCount[sensor.system]) {
          systemCount[sensor.system] = 0;
        }
        systemCount[sensor.system]++;
      }
    });

    for (const system in systemCount) {
      if (systemCount[system] > 1) {
        throw new Error(`Only one NTC sensor is allowed for the ${system} system.`);
      }
    }
  }

  // Initialize GPIO pins asynchronously with error handling
  private async initializeGPIOAsync() {
    try {
      // Initialize GPIO power pins, force power relays to off
      this.config.gpioPowerPins.forEach((pinConfig) => {
        const setPin = new Gpio(pinConfig.set, 'out');
        const resetPin = new Gpio(pinConfig.reset, 'out');
        setPin.writeSync(0); // Set pin to LOW
        resetPin.writeSync(1); // Set pin to HIGH (disables relay)
      });

      // Initialize relay pins
      this.config.relayPins.forEach((config) => {
        config.GPIO.forEach((pin) => {
          const relayPin = new Gpio(pin, 'out');
          relayPin.writeSync(0); // Set pin to LOW
        });
      });

      // Initialize sauna door pin
      if (this.config.saunaDoorPin !== undefined) {
        new Gpio(this.config.saunaDoorPin, 'in', this.config.saunaDoorNO ? 'rising' : 'falling');
      }

      // Initialize steam door pin
      if (this.config.steamDoorPin !== undefined) {
        new Gpio(this.config.steamDoorPin, 'in', this.config.steamDoorNO ? 'rising' : 'falling');
      }
    } catch (error) {
      this.platform.log.error('Failed to initialize GPIO pins:', error);
      throw error;
    }
  }

  // Close GPIO pins during cleanup
  private cleanupGPIO() {
    this.config.relayPins.forEach((config) => {
      config.GPIO.forEach((pin) => {
        const relayPin = new Gpio(pin, 'out');
        relayPin.unexport();
      });
    });
  }

  private setupAccessory() {
    // GPIO initialization is already done in initializeGPIOAsync
    // Setup other services and monitoring

    // Setup thermostats based on config
    if (this.config.hasSauna) {
      this.addThermostatService(
        'Sauna Thermostat',
        'sauna-thermostat',
        this.handleStateSet.bind(this, 'sauna'),
        this.handleTemperatureSet.bind(this, 'sauna'),
      );
    }

    if (this.config.hasSteam) {
      this.addThermostatService(
        'Steam Thermostat',
        'steam-thermostat',
        this.handleStateSet.bind(this, 'steam'),
        this.handleTemperatureSet.bind(this, 'steam'),
      );
    }

    if (this.config.hasLight) {
      this.lightPowerSwitch = this.addSwitchService('Light Power', 'light-power', this.handleLightPowerSet.bind(this));
    }

    if (this.config.hasFan) {
      this.fanPowerSwitch = this.addSwitchService('Fan Power', 'fan-power', this.handleFanPowerSet.bind(this));
    }

    // Setup auxiliary temperature sensors
    this.config.thermistors.forEach((sensor) => {
      const sensorName = sensor.name;
      const thermistorService =
        this.accessory.getService(sensorName) ||
        this.accessory.addService(this.platform.Service.TemperatureSensor, sensorName, `aux-${sensor.channel}`);

      // Store the service in the map for later updates
      if (thermistorService) {
        this.temperatureSensors.set(sensorName, thermistorService);
      }
    });

    // Setup steam temperature
    if (this.config.hasSteam) {
      this.addTemperatureSensorService('Steam Temperature', 'steam-temperature');
    }

    // Setup door sensors
    if (this.config.hasSauna) {
      this.addContactSensorService('Sauna Door', 'sauna-door');
    }

    if (this.config.hasSteam) {
      this.addContactSensorService('Steam Door', 'steam-door');
    }

    // Monitor temperatures
    this.monitorTemperatures();
  }

  // Set the name characteristic for the power switch
  private addSwitchService(name: string, subtype: string, onSetHandler: (value: CharacteristicValue) => void): Service {
    const switchService =
      this.accessory.getService(subtype) || this.accessory.addService(this.platform.Service.Switch, name, subtype);
    switchService.getCharacteristic(this.platform.Characteristic.On).onSet(onSetHandler);
    switchService.setCharacteristic(this.platform.Characteristic.Name, name);
    return switchService;
  }

  // Set the name characteristic for the thermostat
  private addThermostatService(
    name: string,
    subtype: string,
    powerSetHandler: (value: CharacteristicValue) => void,
    temperatureSetHandler: (value: CharacteristicValue) => void,
  ): Service {
    const thermostatService =
      this.accessory.getService(subtype) || this.accessory.addService(this.platform.Service.Thermostat, name, subtype);

    // Set service name
    thermostatService.setCharacteristic(this.platform.Characteristic.Name, name);

    // Restrict target states to "Off" and "Heat"
    thermostatService
      .getCharacteristic(this.platform.Characteristic.TargetHeatingCoolingState)
      .setProps({
        validValues: [
          this.platform.Characteristic.TargetHeatingCoolingState.OFF,
          this.platform.Characteristic.TargetHeatingCoolingState.HEAT,
        ],
      })
      .onSet(powerSetHandler);

    // Initialize the target and current mode to "Off" to avoid unexpected behavior
    thermostatService
      .getCharacteristic(this.platform.Characteristic.TargetHeatingCoolingState)
      .updateValue(this.platform.Characteristic.TargetHeatingCoolingState.OFF);

    thermostatService
      .getCharacteristic(this.platform.Characteristic.CurrentHeatingCoolingState)
      .updateValue(this.platform.Characteristic.CurrentHeatingCoolingState.OFF);

    // Set the temperature properties based on config
    const maxTemperature =
      subtype === 'sauna-thermostat' ? this.config.saunaMaxTemperature : this.config.steamMaxTemperature;

    thermostatService
      .getCharacteristic(this.platform.Characteristic.TargetTemperature)
      .setProps({
        minValue: 0,
        maxValue: maxTemperature,
        minStep: 0.5,
      })
      .onSet((value) => {
        temperatureSetHandler(value); // Pass the value directly as Celsius
      });

    return thermostatService;
  }

  // Set the name characteristic for the temperature sensor
  private addTemperatureSensorService(name: string, subtype: string): Service {
    const tempService =
      this.accessory.getService(subtype) ||
      this.accessory.addService(this.platform.Service.TemperatureSensor, name, subtype);
    tempService.setCharacteristic(this.platform.Characteristic.Name, name);
    return tempService;
  }

  // Set the name characteristic for the contact sensor
  private addContactSensorService(name: string, subtype: string): Service {
    const contactService =
      this.accessory.getService(subtype) ||
      this.accessory.addService(this.platform.Service.ContactSensor, name, subtype);
    contactService.setCharacteristic(this.platform.Characteristic.Name, name);
    return contactService;
  }

  private handleLightPowerSet(value: CharacteristicValue) {
    this.platform.log.info('Light Power:', value);

    const lightPins = this.config.relayPins.find((config) => config.system === 'light')?.GPIO;

    if (lightPins && lightPins.length > 0) {
      lightPins.forEach((pin) => {
        const relayPin = new Gpio(pin, 'out');
        relayPin.writeSync(value ? 1 : 0);
      });
    } else {
      this.platform.log.warn('No GPIO pins configured for light.');
    }

    // Update the characteristic value to reflect the current state
    this.lightPowerSwitch?.updateCharacteristic(this.platform.Characteristic.On, value);
  }

  private handleFanPowerSet(value: CharacteristicValue) {
    this.platform.log.info('Fan Power:', value);

    const fanConfig = this.config.relayPins.find((config) => config.system === 'fan');
    const fanPins = fanConfig?.GPIO;

    if (fanPins && fanPins.length > 0) {
      fanPins.forEach((pin) => {
        const relayPin = new Gpio(pin, 'out');
        relayPin.writeSync(value ? 1 : 0);
      });
    } else {
      this.platform.log.warn('No GPIO pins configured for fan.');
    }

    // Update the characteristic value to reflect the current state
    this.fanPowerSwitch?.updateCharacteristic(this.platform.Characteristic.On, value);
  }

  // ONLY TO BE USED FOR SAUNA OR STEAM. Use setPowerState for switches (lights, fan).
  private async handleStateSet(system: SystemType, value: CharacteristicValue) {
    if (!system) {
      this.platform.log.warn('System is null or undefined. Cannot handle state.');
      return;
    }

    const otherSystem = system === 'sauna' ? 'steam' : 'sauna';
    const otherService = this.accessory.getService(`${otherSystem}-thermostat`);
    const otherSystemRunning =
      otherService?.getCharacteristic(this.platform.Characteristic.CurrentHeatingCoolingState).value ===
      this.platform.Characteristic.CurrentHeatingCoolingState.HEAT;

    // Log the requested state (HEAT or OFF)
    this.platform.log.info(`[Request] handleStateSet(${system}):`, value ? 'HEAT' : 'OFF');

    // Get the target temperature for logging
    const thermostatService = this.accessory.getService(`${system}-thermostat`);
    if (thermostatService) {
      const targetTemperature = thermostatService.getCharacteristic(this.platform.Characteristic.TargetTemperature).value;
      this.platform.log.info(`${system} Target Temperature: ${targetTemperature}°C`);
    }

    if (otherSystemRunning && value === this.platform.Characteristic.TargetHeatingCoolingState.HEAT) {
      this.platform.log.info('OTHER SYSTEM MUST BE TURNED OFF FIRST.');

      // Ensure this does not cause a deadlock or infinite wait
      try {
        await this.turnOffOtherSystem(otherSystem);
      } catch (error) {
        this.platform.log.error(`Failed to turn off ${otherSystem}:`, error);
        return;
      }

      this.platform.log.info(`handleStateSet(${system}): OTHER SYSTEM TURNED OFF`);
    }

    // Check if the system is already in the desired mode
    if (Number(value) === this.platform.Characteristic.TargetHeatingCoolingState.HEAT) {
      this.startSystem(system);
    } else if (Number(value) === this.platform.Characteristic.TargetHeatingCoolingState.OFF) {
      this.stopSystem(system);
    } else {
      this.platform.log.warn('Unexpected TargetHeatingCoolingState:', value);
    }
  }

  private async turnOffOtherSystem(system: SystemType) {
    const service = this.accessory.getService(`${system}-thermostat`);
    if (service) {
      const currentState = service.getCharacteristic(this.platform.Characteristic.CurrentHeatingCoolingState).value;

      if (currentState === this.platform.Characteristic.CurrentHeatingCoolingState.HEAT) {
        this.platform.log.info(`Turning off ${system} before starting the other system.`);
        this.stopSystem(system);
      }
    }
  }

  private handleTemperatureSet(system: SystemType, value: CharacteristicValue) {
    if (!system) {
      this.platform.log.warn('System is null or undefined. Cannot handle state.');
      return;
    }
    this.platform.log.info(`${system} Temperature Request:`, value);

    const service = this.accessory.getService(`${system}-thermostat`);
    if (service) {
      service.getCharacteristic(this.platform.Characteristic.TargetTemperature).updateValue(value);

      this.platform.log.info(`${system} Target Updated: ${value}`);
    }
  }

  // Start a system w/ timeout. Update thermostat state & current to OFF.
  private startSystem(system: SystemType) {
    this.setPowerState(system, true);

    // [ToDo] Generalize this getService to work for thermostats AND switches
    // Update the CurrentHeatingCoolingState to HEAT
    const thermostatService = this.accessory.getService(`${system}-thermostat`);
    if (thermostatService) {
      thermostatService
        .getCharacteristic(this.platform.Characteristic.TargetHeatingCoolingState)
        .updateValue(this.platform.Characteristic.TargetHeatingCoolingState.HEAT);
    }
    this.platform.log.info(`startSystem(${system}): HEAT`);

    // Clear the appropriate timer based on the system
    if (system === 'sauna') {
      this.monitorDoors(system, true);
      const timeout = this.config.saunaTimeout;
      if (this.saunaTimer) {
        clearTimeout(this.saunaTimer);
      }
      this.saunaTimer = setTimeout(() => {
        this.platform.log.warn(`${system} powering off after ${timeout} minutes timeout.`);
        this.stopSystem(system);
      }, timeout * 60000); // minutes
    } else if (system === 'steam') {
      const timeout = this.config.steamTimeout;
      if (this.steamTimer) {
        clearTimeout(this.steamTimer);
      }
      this.steamTimer = setTimeout(() => {
        this.platform.log.warn(`${system} powering off after ${timeout} minutes timeout.`);
        this.stopSystem(system);
      }, timeout * 60000); // minutes
    }
  }

  // Stop a system, clear timeout. Update Thermostat state & current to OFF.
  private stopSystem(system: SystemType) {
    this.monitorDoors(system, false);

    const service = this.accessory.getService(`${system}-thermostat`);

    if (service) {
      // Check if relays are already off
      const currentMode = service.getCharacteristic(this.platform.Characteristic.CurrentHeatingCoolingState).value;

      if (currentMode === this.platform.Characteristic.TargetHeatingCoolingState.OFF) {
        this.platform.log.info('System already off. Skipping relay actuation.');
        return;
      } else {
        this.setPowerState(system, false);
      }

      service
        .getCharacteristic(this.platform.Characteristic.TargetHeatingCoolingState)
        .updateValue(this.platform.Characteristic.TargetHeatingCoolingState.OFF);
    }
    this.platform.log.info(`stopSystem(${system}): OFF`);

    // Clear the appropriate timer based on the system
    if (system === 'sauna') {
      if (this.saunaTimer) {
        clearTimeout(this.saunaTimer);
        this.saunaTimer = null;
      }
    } else if (system === 'steam') {
      if (this.steamTimer) {
        clearTimeout(this.steamTimer);
        this.steamTimer = null;
      }
    }
  }

  // Utility to set power state on GPIO for thermostats & switches
  private setPowerState(system: SystemType, state: boolean) {
    const GPIO = this.config.relayPins.find((config) => config.system === system)?.GPIO;

    if (!GPIO || GPIO.length === 0) {
      this.platform.log.warn(`No GPIO pins configured for ${system}.`);
      return;
    }

    const powerState = state ? 1 : 0;
    GPIO?.forEach((pin) => {
      const relayPin = new Gpio(pin, 'out');
      this.platform.log.info(`${system}: setPowerState --> ${pin} ${state ? 'ON' : 'OFF'}`);
      relayPin.writeSync(powerState);
    });
  }

  private InvalidTemperatureReading( temperatureCelsius : number) {
    return temperatureCelsius < -20 || temperatureCelsius > 150;
  }

  // Monitor temperatures using ADC channels
  private monitorTemperatures() {
    if (process.env.NODE_ENV === 'test') {
      this.platform.log.info('Skipping temperature monitoring in test environment');
      return;
    }

    this.config.thermistors.forEach((sensor) => {
      const adcChannel = sensor.channel as EightChannels;

      // Open ADC channel for each sensor independently
      const sensorAdc = openMcp3008(adcChannel, { speedHz: 1350000 }, (err) => {
        if (err) {
          this.platform.log.error(`Failed to open ADC channel ${adcChannel} for sensor "${sensor.system}": ${err}`);
          return;
        }

        const readTemperature = () => {
          sensorAdc.read((err: string | null, reading: McpReading) => {
            if (err) {
              this.platform.log.error(`Failed to read temperature for sensor "${sensor.name}": ${err}`);
              return;
            }

            // Convert the ADC reading to celsius
            const temperatureCelsius = Math.round(this.calculateTemperature(reading.value, sensor.resistanceAt25C, sensor.bValue));

            const thermistorService = this.temperatureSensors.get(sensor.name);
            if (thermistorService) {

              // Invalid Temperature (e.g., sensor disconnected)
              if (this.InvalidTemperatureReading(temperatureCelsius)) {
                this.platform.log.warn(`${sensor.name} Temperature: ${temperatureCelsius} °C (invalid)`);

                // Update the HomeKit characteristic with the current temperature
                thermistorService.updateCharacteristic(this.platform.Characteristic.CurrentTemperature, 0);

                // ToDo: Does this need to be reset to clear fault once temperature is valid?
                // Reflect the invalid state in the HomeKit UI or log
                thermistorService.updateCharacteristic(
                  this.platform.Characteristic.StatusFault,
                  this.platform.Characteristic.StatusFault.GENERAL_FAULT,
                );
                return;
              }

              // Valid Temperature. Update the HomeKit characteristic with the current temperature.
              thermistorService.updateCharacteristic(
                this.platform.Characteristic.CurrentTemperature,
                temperatureCelsius,
              );

              this.platform.log.info(`${sensor.name} Temperature: ${temperatureCelsius} °C`);
            }

            // Perform actions based on the temperature reading
            if (sensor.system === 'sauna') {
              this.handleTemperatureControl('sauna', temperatureCelsius);
            } else if (sensor.system === 'steam') {
              this.handleTemperatureControl('steam', temperatureCelsius);
            }

            // Monitor PCB temperature for power relay actuation
            if (sensor.system === 'controller') {
              this.handleControllerTemperature(temperatureCelsius);
            }
          });
        };

        // Set up a regular interval to read from the ADC channel
        setInterval(readTemperature, 5000);
      });
    });
  }

  // Controller temperature and control relays
  private async handleControllerTemperature(temperatureCelsius: number): Promise<void> {
    if (temperatureCelsius <= this.config.controllerSafetyTemperature && !this.relaysEnabled) {
      this.enable120VRelays();
    } else if (temperatureCelsius > this.config.controllerSafetyTemperature && this.relaysEnabled) {
      this.flashLights(10); // Flash warning lights
      this.disableAllRelays(); // Disable all auxiliary relays (lights, fan, steam)
      this.disable120VRelays(); // Disable main power (120V) pins
    }
  }

  private async enable120VRelays(): Promise<void> {
    if (!this.relaysEnabled) {
      for (const [index, pinConfig] of this.config.gpioPowerPins.entries()) {
        this.platform.log.info(`Enabling 120V Relay: Set Pin ${pinConfig.set}, Reset Pin ${pinConfig.reset}`);
        const resetPin = new Gpio(pinConfig.reset, 'out');
        const setPin = new Gpio(pinConfig.set, 'out');
        resetPin.writeSync(0); // Ensure the reset pin is LOW
        await this.delay(20); // Wait to ensure the reset has taken effect
        setPin.writeSync(1); // Set pin HIGH to enable the relay
        await this.delay(20); // Ensure the relay has fully engaged
        this.platform.log.info(`Relay ${index + 1} enabled.`);
      }
      this.relaysEnabled = true; // Update the state to reflect that relays are now enabled
    }
  }

  private async disable120VRelays(): Promise<void> {
    if (this.relaysEnabled) {
      for (const [index, pinConfig] of this.config.gpioPowerPins.entries()) {
        this.platform.log.info(`Disabling 120V Relay: Set Pin ${pinConfig.set}, Reset Pin ${pinConfig.reset}`);
        const setPin = new Gpio(pinConfig.set, 'out');
        const resetPin = new Gpio(pinConfig.reset, 'out');
        setPin.writeSync(0); // Ensure the set pin is LOW
        await this.delay(20); // Wait to ensure the set has taken effect
        resetPin.writeSync(1); // Reset pin HIGH to disable the relay
        await this.delay(20); // Ensure the relay has fully disengaged
        this.platform.log.info(`Relay ${index + 1} disabled.`);
      }
      this.relaysEnabled = false; // Update the state to reflect that relays are now disabled
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private handleTemperatureControl(system: SystemType, temperatureCelsius: number) {
    let maxTemperature: number | undefined;
    let safetyTemperature: number | undefined;
    let thermostatService: Service | undefined;

    switch (system) {
      case 'sauna':
        maxTemperature = this.config.saunaMaxTemperature;
        safetyTemperature = this.config.saunaSafetyTemperature;
        thermostatService = this.accessory.getService('sauna-thermostat');
        break;
      case 'steam':
        maxTemperature = this.config.steamMaxTemperature;
        safetyTemperature = this.config.steamSafetyTemperature;
        thermostatService = this.accessory.getService('steam-thermostat');
        break;
    }

    if (!thermostatService) {
      return; // Exit if no thermostat service is found
    }

    const targetMode = thermostatService.getCharacteristic(
      this.platform.Characteristic.TargetHeatingCoolingState,
    ).value;

    // Exit early if the target mode is not HEAT
    if (targetMode !== this.platform.Characteristic.TargetHeatingCoolingState.HEAT) {
      return;
    }

    // Ensure power remains off for invalid readings
    if (this.InvalidTemperatureReading(temperatureCelsius)) {
      this.platform.log.error(`${system} has an invalid signal. Power off due to invalid reading.`);
      this.stopSystem(system);
      return; // Exit early since the reading is invalid
    }

    // Check safety temperature for critical shutdown
    if (safetyTemperature !== undefined && temperatureCelsius >= safetyTemperature) {
      this.platform.log.warn(`${system} exceeded safety temperature! Immediate power off and flashing lights.`);
      this.stopSystem(system);
      this.flashLights(10); // Flash warning lights
      return; // Exit to ensure no further action is taken
    }

    // Check normal operational max temperature
    if (maxTemperature !== undefined && temperatureCelsius >= maxTemperature) {
      this.platform.log.warn(`${system} exceeded max temperature. Power off and flashing lights.`);
      this.stopSystem(system);
      this.flashLights(10); // Flash warning lights
      return; // Exit to ensure no further action is taken
    }

    const targetTemperature = thermostatService.getCharacteristic(this.platform.Characteristic.TargetTemperature)
      .value as number;

    const currentMode = thermostatService.getCharacteristic(
      this.platform.Characteristic.CurrentHeatingCoolingState,
    ).value;

    if (
      // If not in HEAT mode and temperature is below target, turn on the heater
      currentMode !== this.platform.Characteristic.CurrentHeatingCoolingState.HEAT &&
      temperatureCelsius < targetTemperature
    ) {
      this.platform.log.info(`${system} below setpoint.`);
      this.setPowerState(system, true);
    } else if (
      // If in HEAT mode and temperature is above target, turn off the heater
      currentMode === this.platform.Characteristic.CurrentHeatingCoolingState.HEAT &&
      temperatureCelsius >= targetTemperature
    ) {
      // Turn off heater if temperature reaches or exceeds target
      this.platform.log.info(`${system} above setpoint.`);
      this.setPowerState(system, false);
    }
  }

  private flashLights(times: number) {
    const lightGpio: SystemType = 'light'; // This should be of type SystemType
    const gpioPowerPins = this.config.relayPins.find((config) => config.system === lightGpio)?.GPIO ?? [];

    if (gpioPowerPins && gpioPowerPins.length > 0) {
      this.platform.log.info(`Flashing lights ${times} times.`);
      for (let i = 0; i < times; i++) {
        this.setPowerState(lightGpio, true);
        // [ToDo] Use a delay mechanism here if needed
        this.setPowerState(lightGpio, false);
      }
    } else {
      this.platform.log.error('Light pin is not configured.');
    }
  }

  // Disable all relays and flash warning lights
  private disableAllRelays() {
    // Iterate through each configuration in relayPins
    this.config.relayPins.forEach((config) => {
      // For each system, turn off all associated GPIO
      config.GPIO.forEach((pin) => {
        const relayPin = new Gpio(pin, 'out');
        relayPin.writeSync(0);
      });
    });

    this.platform.log.info('All relays have been disabled.');
  }

  public getPlatform(): OpenSpaPlatform {
    return this.platform;
  }

  public clearIntervalsAndTimeouts() {
    if (this.saunaTimer) {
      clearTimeout(this.saunaTimer);
      this.saunaTimer = null;
    }
    if (this.steamTimer) {
      clearTimeout(this.steamTimer);
      this.steamTimer = null;
    }
  }

  // Monitor or stop monitoring door states for sauna or steam
  private monitorDoors(system: SystemType, monitor: boolean) {
    let doorSensor: number | undefined;
    let inverse: boolean | undefined;
    let allowOnWhileOpen: boolean | undefined;

    if (system === 'sauna') {
      doorSensor = this.config.saunaDoorPin;
      inverse = this.config.saunaDoorNO;
      allowOnWhileOpen = this.config.saunaOnWhileDoorOpen;
    } else if (system === 'steam') {
      doorSensor = this.config.steamDoorPin;
      inverse = this.config.steamDoorNO;
      allowOnWhileOpen = this.config.steamOnWhileDoorOpen;
    } else {
      return;
    }

    if (doorSensor !== undefined) {
      if (monitor) {
        try {
          // Check if poll was registered
          if (this.doorPollRegistered[doorSensor]) {
            this.platform.log.info(`Poll for ${system} door already registered.`);
            return;
          }

          const doorPin = new Gpio(doorSensor, 'in', 'both');
          doorPin.watch((err, value) => {
            if (err) {
              this.platform.log.error(`Error watching ${system} door: ${err}`);
              return;
            }

            const doorOpen = inverse ? value === 0 : value === 1;
            this.platform.log.info(`${system} Door ${doorOpen ? 'Open' : 'Closed'}`);

            const doorService = this.accessory.getService(`${system}-door`);

            if (doorService) {
              doorService.updateCharacteristic(
                this.platform.Characteristic.ContactSensorState,
                doorOpen
                  ? this.platform.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
                  : this.platform.Characteristic.ContactSensorState.CONTACT_DETECTED,
              );
            }

            const service = this.accessory.getService(`${system}-thermostat`);

            if (doorOpen && !allowOnWhileOpen) {
              // Ensure the heater turns off if set to not operate with door open.
              this.setPowerState(system, false);
              this.platform.log.warn(`${system} power off due to door open.`);
            } else if (!doorOpen && !allowOnWhileOpen) {
              // Ensure the heater is resumed only when it was initially turned off due to the door open state
              this.setPowerState(system, true);
              this.platform.log.info(`${system} power resumed as door closed.`);
            }
          });

          // Mark the poll as registered
          this.doorPollRegistered[doorSensor] = true;
        } catch (error) {
          this.platform.log.error(`Error setting up poll for ${system} door: ${error}`);
        }
      } else {
        // Unregister the poll if it exists
        if (this.doorPollRegistered[doorSensor]) {
          try {
            const doorPin = new Gpio(doorSensor, 'in');
            doorPin.unwatchAll();
            doorPin.unexport();
            this.doorPollRegistered[doorSensor] = false;
            this.platform.log.info(`Stopped monitoring ${system} door.`);
          } catch (error) {
            this.platform.log.error(`Error unregistering poll for ${system} door: ${error}`);
          }
        }
      }
    } else {
      this.platform.log.warn(`No door pin configured for ${system}`);
    }
  }

  private calculateTemperature(adcValue: number, resistanceAt25C: number, bValue: number): number {
    const pullUpResistor = 10000; // 10k ohm pull-up resistor
    const piVoltage = 3.3; // Reference voltage used by the ADC (e.g., 3.3V)
    const voltage = adcValue * piVoltage; // Convert ADC value to voltage

    // Calculate the thermistor resistance using the voltage divider formula
    const resistance = (piVoltage / voltage - 1.0) * pullUpResistor;

    // Apply the Steinhart-Hart equation to calculate the temperature in Celsius
    let steinhart = resistance / resistanceAt25C; // R/Ro
    steinhart = Math.log(steinhart); // ln(R/Ro)
    steinhart /= bValue; // 1/B * ln(R/Ro)
    steinhart += 1.0 / (25 + 273.15); // + (1/To)
    steinhart = 1.0 / steinhart; // Invert
    steinhart -= 273.15; // convert to Celsius

    return steinhart;
  }
}
