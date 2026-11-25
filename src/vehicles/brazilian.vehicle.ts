import {
  ChargeTarget,
  DEFAULT_VEHICLE_STATUS_OPTIONS,
  POSSIBLE_CHARGE_LIMIT_VALUES,
  REGIONS,
} from '../constants';
import {
  DeepPartial,
  EVChargeModeTypes,
  EVPlugTypes,
  FullVehicleStatus,
  RawVehicleStatus,
  VehicleDayTrip,
  VehicleLocation,
  VehicleMonthTrip,
  VehicleMonthlyReport,
  VehicleOdometer,
  VehicleRegisterOptions,
  VehicleStartOptions,
  VehicleStatus,
  VehicleStatusOptions,
  VehicleTargetSOC,
  VehicleWindowsOptions,
} from '../interfaces/common.interfaces';

import got, { GotInstance, GotJSONFn } from 'got';
import { BrazilianController } from '../controllers/brazilian.controller';
import {
  EUDatedDriveHistory,
  EUDriveHistory,
  EUPOIInformation,
  historyDrivingPeriod,
} from '../interfaces/european.interfaces';
import logger from '../logger';
import { ManagedBluelinkyError, manageBluelinkyError } from '../tools/common.tools';
import { addMinutes, celciusToTempCode, parseDate } from '../util';
import { Vehicle } from './vehicle';

export default class BrazilianVehicle extends Vehicle {
  public region = REGIONS.BR;
  public serverRates: {
    max: number;
    current: number;
    reset?: Date;
    updatedAt?: Date;
  } = {
    max: -1,
    current: -1,
  };

  constructor(
    public vehicleConfig: VehicleRegisterOptions,
    public controller: BrazilianController
  ) {
    super(vehicleConfig, controller);
    logger.debug(`BR Vehicle ${this.vehicleConfig.id} created`);
  }

  public async start(config: VehicleStartOptions): Promise<string> {
    const http = await this.controller.getVehicleHttpService();
    try {
      const response = this.updateRates(
        await http.post(`/api/v2/spa/vehicles/${this.vehicleConfig.id}/control/engine`, {
          body: {
            action: 'start',
            hvacType: 0,
            options: {
              defrost: config.defrost,
              heating1: config.heatedFeatures ? 1 : 0,
            },
            tempCode: celciusToTempCode(REGIONS.BR, config.temperature),
            unit: config.unit,
          },
        })
      );
      logger.info(`Climate started for vehicle ${this.vehicleConfig.id}`);
      return response.body;
    } catch (err) {
      throw manageBluelinkyError(err, 'BrazilVehicle.start');
    }
  }

  public async stop(): Promise<string> {
    const http = await this.controller.getVehicleHttpService();
    try {
      const response = this.updateRates(
        await http.post(`/api/v2/spa/vehicles/${this.vehicleConfig.id}/control/engine`, {
          body: {
            action: 'stop',
            hvacType: 0,
            options: {
              defrost: true,
              heating1: 1,
            },
            tempCode: '10H',
            unit: 'C',
          },
        })
      );
      logger.info(`Climate stopped for vehicle ${this.vehicleConfig.id}`);
      return response.body;
    } catch (err) {
      throw manageBluelinkyError(err, 'BrazilVehicle.stop');
    }
  }

  public async lock(): Promise<string> {
    const http = await this.controller.getVehicleHttpService();
    try {
      const response = this.updateRates(
        await http.post(`/api/v2/spa/vehicles/${this.vehicleConfig.id}/control/door`, {
          headers: this.controlRequestHeaders(),
          body: {
            action: 'close',
            deviceId: this.controller.session.deviceId,
          },
        })
      );
      if (response.statusCode === 200) {
        logger.debug(`Vehicle ${this.vehicleConfig.id} locked`);
        return 'Lock successful';
      }
      return 'Something went wrong!';
    } catch (err) {
      throw manageBluelinkyError(err, 'BrazilVehicle.lock');
    }
  }

  public async unlock(): Promise<string> {
    const http = await this.controller.getVehicleHttpService();
    try {
      const response = this.updateRates(
        await http.post(`/api/v2/spa/vehicles/${this.vehicleConfig.id}/control/door`, {
          headers: this.controlRequestHeaders(),
          body: {
            action: 'open',
            deviceId: this.controller.session.deviceId,
          },
        })
      );

      if (response.statusCode === 200) {
        logger.debug(`Vehicle ${this.vehicleConfig.id} unlocked`);
        return 'Unlock successful';
      }

      return 'Something went wrong!';
    } catch (err) {
      throw manageBluelinkyError(err, 'BrazilVehicle.unlock');
    }
  }

  public async setWindows(config: VehicleWindowsOptions): Promise<string> {
    const http = await this.controller.getVehicleHttpService();
    try {
      const response = this.updateRates(
        await http.post(`/api/v2/spa/vehicles/${this.vehicleConfig.id}/control/windowcurtain`, {
          body: config,
        })
      );
      return response.body;
    } catch (err) {
      throw manageBluelinkyError(err, 'BrazilVehicle.setWindows');
    }
  }

  public async fullStatus(input: VehicleStatusOptions): Promise<FullVehicleStatus | null> {
    const statusConfig = {
      ...DEFAULT_VEHICLE_STATUS_OPTIONS,
      ...input,
    };

    const apiClient = await this.controller.getApiHttpService();

    try {
      const vehicleStatus = await this.fetchCcs2VehicleState(
        apiClient,
        statusConfig.refresh
      );
      const odometer = vehicleStatus?.Drivetrain?.Odometer
        ? (vehicleStatus.Drivetrain.Odometer as VehicleOdometer)
        : await this.odometer();

      if (!odometer) {
        return null;
      }

      this._fullStatus = {
        vehicleLocation: vehicleStatus?.Location ?? vehicleStatus?.Green?.Location,
        odometer,
        vehicleStatus,
      };
      return this._fullStatus;
    } catch (err) {
      throw manageBluelinkyError(err, 'BrazilVehicle.fullStatus');
    }
  }

  public async status(
    input: VehicleStatusOptions
  ): Promise<VehicleStatus | RawVehicleStatus | null> {
    const statusConfig = {
      ...DEFAULT_VEHICLE_STATUS_OPTIONS,
      ...input,
    };

    const http = await this.controller.getApiHttpService();

    try {
      const vehicleStatus = await this.fetchCcs2VehicleState(http, statusConfig.refresh);
      const parsedStatus = this.parseCcs2VehicleStatus(vehicleStatus);

      this._status = statusConfig.parsed ? parsedStatus : vehicleStatus;

      return this._status;
    } catch (err) {
      throw manageBluelinkyError(err, 'BrazilVehicle.status');
    }
  }

  public async odometer(): Promise<VehicleOdometer | null> {
    const http = await this.controller.getApiHttpService();
    try {
      const response = this.updateRates(
        await http.get(
          `/api/v1/spa/vehicles/${this.vehicleConfig.id}/ccs2/carstatus/latest`
        )
      );
      const odometer = response.body.resMsg?.state?.Vehicle?.Drivetrain?.Odometer;
      if (odometer) {
        this._odometer = odometer as VehicleOdometer;
        return this._odometer;
      }
      return null;
    } catch (err) {
      throw manageBluelinkyError(err, 'BrazilVehicle.odometer');
    }
  }

  public async location(): Promise<VehicleLocation> {
    const http = await this.controller.getApiHttpService();
    try {
      const response = this.updateRates(
        await http.get(`/api/v1/spa/vehicles/${this.vehicleConfig.id}/location/park`)
      );

      const data = response.body.resMsg?.coord
        ? response.body.resMsg
        : response.body.resMsg?.gpsDetail;
      this._location = {
        latitude: data?.coord?.lat,
        longitude: data?.coord?.lon,
        altitude: data?.coord?.alt,
        speed: {
          unit: data?.speed?.unit,
          value: data?.speed?.value,
        },
        heading: data?.head,
      };

      return this._location;
    } catch (err) {
      throw manageBluelinkyError(err, 'BrazilVehicle.location');
    }
  }

  public async startCharge(): Promise<string> {
    const http = await this.controller.getVehicleHttpService();
    try {
      const response = this.updateRates(
        await http.post(`/api/v2/spa/vehicles/${this.vehicleConfig.id}/control/charge`, {
          body: {
            action: 'start',
            deviceId: this.controller.session.deviceId,
          },
        })
      );

      if (response.statusCode === 200) {
        logger.debug(`Send start charge command to Vehicle ${this.vehicleConfig.id}`);
        return 'Start charge successful';
      }

      throw 'Something went wrong!';
    } catch (err) {
      throw manageBluelinkyError(err, 'BrazilVehicle.startCharge');
    }
  }

  public async stopCharge(): Promise<string> {
    const http = await this.controller.getVehicleHttpService();
    try {
      const response = this.updateRates(
        await http.post(`/api/v2/spa/vehicles/${this.vehicleConfig.id}/control/charge`, {
          body: {
            action: 'stop',
            deviceId: this.controller.session.deviceId,
          },
        })
      );

      if (response.statusCode === 200) {
        logger.debug(`Send stop charge command to Vehicle ${this.vehicleConfig.id}`);
        return 'Stop charge successful';
      }

      throw 'Something went wrong!';
    } catch (err) {
      throw manageBluelinkyError(err, 'BrazilVehicle.stopCharge');
    }
  }

  public async monthlyReport(
    month: { year: number; month: number } = {
      year: new Date().getFullYear(),
      month: new Date().getMonth() + 1,
    }
  ): Promise<DeepPartial<VehicleMonthlyReport> | undefined> {
    const http = await this.controller.getVehicleHttpService();
    try {
      const response = this.updateRates(
        await http.post(`/api/v2/spa/vehicles/${this.vehicleConfig.id}/monthlyreport`, {
          body: {
            setRptMonth: toMonthDate(month),
          },
        })
      );
      const rawData = response.body.resMsg?.monthlyReport;
      if (rawData) {
        return {
          start: rawData.ifo?.mvrMonthStart,
          end: rawData.ifo?.mvrMonthEnd,
          breakdown: rawData.breakdown,
          driving: rawData.driving
            ? {
                distance: rawData.driving?.runDistance,
                startCount: rawData.driving?.engineStartCount,
                durations: {
                  idle: rawData.driving?.engineIdleTime,
                  drive: rawData.driving?.engineOnTime,
                },
              }
            : undefined,
          vehicleStatus: rawData.vehicleStatus
            ? {
                tpms: rawData.vehicleStatus?.tpmsSupport
                  ? Boolean(rawData.vehicleStatus?.tpmsSupport)
                  : undefined,
                tirePressure: {
                  all: rawData.vehicleStatus?.tirePressure?.tirePressureLampAll == '1',
                },
              }
            : undefined,
        };
      }
      return;
    } catch (err) {
      throw manageBluelinkyError(err, 'BrazilVehicle.monthyReports');
    }
  }

  public async tripInfo(date: {
    year: number;
    month: number;
    day: number;
  }): Promise<DeepPartial<VehicleDayTrip>[] | undefined>;
  public async tripInfo(date?: {
    year: number;
    month: number;
  }): Promise<DeepPartial<VehicleMonthTrip> | undefined>;

  public async tripInfo(
    date: { year: number; month: number; day?: number } = {
      year: new Date().getFullYear(),
      month: new Date().getMonth() + 1,
    }
  ): Promise<DeepPartial<VehicleDayTrip>[] | DeepPartial<VehicleMonthTrip> | undefined> {
    const http = await this.controller.getApiHttpService();
    try {
      const perDay = Boolean(date.day);
      const response = this.updateRates(
        await http.post(`/api/v1/spa/vehicles/${this.vehicleConfig.id}/tripinfo`, {
          body: {
            setTripLatest: 10,
            setTripMonth: !perDay ? toMonthDate(date) : undefined,
            setTripDay: perDay ? toDayDate(date) : undefined,
            tripPeriodType: perDay ? 1 : 0,
          },
        })
      );

      if (!perDay) {
        const rawData = response.body.resMsg;
        return {
          days: Array.isArray(rawData?.tripDayList)
            ? rawData?.tripDayList.map(day => ({
                dayRaw: day.tripDayInMonth,
                date: day.tripDayInMonth ? parseDate(day.tripDayInMonth) : undefined,
                tripsCount: day.tripCntDay,
              }))
            : [],
          durations: {
            drive: rawData?.tripDrvTime,
            idle: rawData?.tripIdleTime,
          },
          distance: rawData?.tripDist,
          speed: {
            avg: rawData?.tripAvgSpeed,
            max: rawData?.tripMaxSpeed,
          },
        } as VehicleMonthTrip;
      } else {
        const rawData = response.body.resMsg.dayTripList;
        if (rawData && Array.isArray(rawData)) {
          return rawData.map(day => ({
            dayRaw: day.tripDay,
            tripsCount: day.dayTripCnt,
            distance: day.tripDist,
            durations: {
              drive: day.tripDrvTime,
              idle: day.tripIdleTime,
            },
            speed: {
              avg: day.tripAvgSpeed,
              max: day.tripMaxSpeed,
            },
            trips: Array.isArray(day.tripList)
              ? day.tripList.map(trip => {
                  const start = parseDate(`${day.tripDay}${trip.tripTime}`);
                  return {
                    timeRaw: trip.tripTime,
                    start,
                    end: addMinutes(start, trip.tripDrvTime),
                    durations: {
                      drive: trip.tripDrvTime,
                      idle: trip.tripIdleTime,
                    },
                    speed: {
                      avg: trip.tripAvgSpeed,
                      max: trip.tripMaxSpeed,
                    },
                    distance: trip.tripDist,
                  };
                })
              : [],
          }));
        }
      }
      return;
    } catch (err) {
      throw manageBluelinkyError(err, 'BrazilVehicle.history');
    }
  }

  public async driveHistory(period: historyDrivingPeriod = historyDrivingPeriod.DAY): Promise<
    DeepPartial<{
      cumulated: EUDriveHistory[];
      history: EUDatedDriveHistory[];
    }>
  > {
    const http = await this.controller.getApiHttpService();
    try {
      const response = await http.post(`/api/v1/spa/vehicles/${this.vehicleConfig.id}/drvhistory`, {
        body: {
          periodTarget: period,
        },
      });
      return {
        cumulated: response.body.resMsg.drivingInfo?.map(line => ({
          period: line.drivingPeriod,
          consumption: {
            total: line.totalPwrCsp,
            engine: line.motorPwrCsp,
            climate: line.climatePwrCsp,
            devices: line.eDPwrCsp,
            battery: line.batteryMgPwrCsp,
          },
          regen: line.regenPwr,
          distance: line.calculativeOdo,
        })),
        history: response.body.resMsg.drivingInfoDetail?.map(line => ({
          period: line.drivingPeriod,
          rawDate: line.drivingDate,
          date: line.drivingDate ? parseDate(line.drivingDate) : undefined,
          consumption: {
            total: line.totalPwrCsp,
            engine: line.motorPwrCsp,
            climate: line.climatePwrCsp,
            devices: line.eDPwrCsp,
            battery: line.batteryMgPwrCsp,
          },
          regen: line.regenPwr,
          distance: line.calculativeOdo,
        })),
      };
    } catch (err) {
      throw manageBluelinkyError(err, 'BrazilVehicle.history');
    }
  }

  public async getChargeTargets(): Promise<DeepPartial<VehicleTargetSOC>[] | undefined> {
    const http = await this.controller.getVehicleHttpService();
    try {
      const response = this.updateRates(
        await http.get(`/api/v2/spa/vehicles/${this.vehicleConfig.id}/charge/target`)
      );
      const rawData = response.body.resMsg?.targetSOClist;
      if (rawData && Array.isArray(rawData)) {
        return rawData.map(rawSOC => ({
          distance: rawSOC.drvDistance?.distanceType?.distanceValue,
          targetLevel: rawSOC.targetSOClevel,
          type: rawSOC.plugType,
        }));
      }
      return;
    } catch (err) {
      throw manageBluelinkyError(err, 'BrazilVehicle.getChargeTargets');
    }
  }

  public async setChargeTargets(limits: { fast: ChargeTarget; slow: ChargeTarget }): Promise<void> {
    const http = await this.controller.getVehicleHttpService();
    if (
      !POSSIBLE_CHARGE_LIMIT_VALUES.includes(limits.fast) ||
      !POSSIBLE_CHARGE_LIMIT_VALUES.includes(limits.slow)
    ) {
      throw new ManagedBluelinkyError(
        `Charge target values are limited to ${POSSIBLE_CHARGE_LIMIT_VALUES.join(', ')}`
      );
    }
    try {
      this.updateRates(
        await http.post(`/api/v2/spa/vehicles/${this.vehicleConfig.id}/charge/target`, {
          body: {
            targetSOClist: [
              { plugType: EVChargeModeTypes.FAST, targetSOClevel: limits.fast },
              { plugType: EVChargeModeTypes.SLOW, targetSOClevel: limits.slow },
            ],
          },
        })
      );
    } catch (err) {
      throw manageBluelinkyError(err, 'BrazilVehicle.setChargeTargets');
    }
  }

  public async setNavigation(poiInformations: EUPOIInformation[]): Promise<void> {
    const http = await this.controller.getVehicleHttpService();
    try {
      this.updateRates(
        await http.post(`/api/v2/spa/vehicles/${this.vehicleConfig.id}/location/routes`, {
          body: {
            deviceID: this.controller.session.deviceId,
            poiInfoList: poiInformations,
          },
        })
      );
    } catch (err) {
      throw manageBluelinkyError(err, 'BrazilVehicle.setNavigation');
    }
  }

  private ccs2StatusPath(suffix: string): string {
    return `/api/v1/spa/vehicles/${this.vehicleConfig.id}/ccs2/carstatus${suffix}`;
  }

  private async fetchCcs2VehicleState(
    http: GotInstance<GotJSONFn>,
    refresh: boolean
  ): Promise<RawVehicleStatus> {
    if (refresh) {
      this.updateRates(await http.get(this.ccs2StatusPath('')));
      await new Promise(resolve => setTimeout(resolve, 15000));
    }

    const response = this.updateRates(await http.get(this.ccs2StatusPath('/latest')));
    return response.body.resMsg.state.Vehicle;
  }

  private parseCcs2VehicleStatus(vehicleStatus: RawVehicleStatus): VehicleStatus {
    const locks = [
      !!vehicleStatus?.Cabin?.Door?.Row1?.Passenger?.Lock,
      !!vehicleStatus?.Cabin?.Door?.Row1?.Driver?.Lock,
      !!vehicleStatus?.Cabin?.Door?.Row2?.Left?.Lock,
      !!vehicleStatus?.Cabin?.Door?.Row2?.Right?.Lock,
    ];

    let plugedTo: EVPlugTypes;
    if (vehicleStatus?.Green?.ChargingInformation?.ConnectorFastening?.State) {
      plugedTo = EVPlugTypes.STATION;
    } else {
      plugedTo = EVPlugTypes.UNPLUGED;
    }

    return {
      chassis: {
        hoodOpen: !!vehicleStatus?.Body?.Hood?.Open,
        trunkOpen: !!vehicleStatus?.Body?.Trunk?.Open,
        locked: locks.every(v => v === false),
        openDoors: {
          frontRight: !!vehicleStatus?.Cabin?.Door?.Row1?.Passenger?.Open,
          frontLeft: !!vehicleStatus?.Cabin?.Door?.Row1?.Driver?.Open,
          backLeft: !!vehicleStatus?.Cabin?.Door?.Row2?.Left?.Open,
          backRight: !!vehicleStatus?.Cabin?.Door?.Row2?.Right?.Open,
        },
        tirePressureWarningLamp: {
          rearLeft: !!vehicleStatus?.Chassis?.Axle?.Row2?.Left?.Tire?.PressureLow,
          frontLeft: !!vehicleStatus?.Chassis?.Axle?.Row1?.Left?.Tire?.PressureLow,
          frontRight: !!vehicleStatus?.Chassis?.Axle?.Row1?.Right?.Tire?.PressureLow,
          rearRight: !!vehicleStatus?.Chassis?.Axle?.Row2?.Right?.Tire?.PressureLow,
          all: !!vehicleStatus?.Chassis?.Axle?.Tire?.PressureLow,
        },
      },
      climate: {
        active: vehicleStatus?.Cabin?.HVAC?.Row1?.Driver?.Temperature?.Value === 'ON',
        steeringwheelHeat: !!vehicleStatus?.Cabin?.SteeringWheel?.Heat?.State,
        sideMirrorHeat: false,
        rearWindowHeat: false,
        defrost: false,
        temperatureSetpoint: '',
        temperatureUnit: 0,
      },
      engine: {
        ignition:
          !!vehicleStatus?.Electronics?.PowerSupply?.Ignition1 ||
          !!vehicleStatus?.Electronics?.PowerSupply?.Ignition3,
        accessory: !!vehicleStatus?.Electronics?.PowerSupply?.Accessory,
        rangeGas: vehicleStatus?.Drivetrain?.FuelSystem?.DTE?.Gas,
        range: vehicleStatus?.Drivetrain?.FuelSystem?.DTE?.Total,
        rangeEV: vehicleStatus?.Drivetrain?.FuelSystem?.DTE?.EV,
        plugedTo: plugedTo,
        charging: undefined,
        estimatedCurrentChargeDuration:
          vehicleStatus?.Green?.ChargingInformation?.Charging?.RemainTime,
        estimatedFastChargeDuration:
          vehicleStatus?.Green?.ChargingInformation?.EstimatedTime?.Quick,
        estimatedPortableChargeDuration:
          vehicleStatus?.Green?.ChargingInformation?.EstimatedTime?.ICCB,
        estimatedStationChargeDuration:
          vehicleStatus?.Green?.ChargingInformation?.EstimatedTime?.Standard,
        batteryCharge12v: vehicleStatus?.Electronics?.Battery?.Level,
        batteryChargeHV: vehicleStatus?.Green?.BatteryManagement?.BatteryRemain?.Ratio,
      },
      lastupdate: vehicleStatus?.Date ? parseDate(vehicleStatus?.Date) : null,
    };
  }

  private controlRequestHeaders() {
    return {
      ccuCCS2ProtocolSupport: this.vehicleConfig.ccuCCS2ProtocolSupport ? '1' : '0',
    };
  }

  private updateRates<T extends Record<string, unknown>>(resp: got.Response<T>): got.Response<T> {
    if (resp.headers?.['x-ratelimit-limit']) {
      this.serverRates.max = Number(resp.headers?.['x-ratelimit-limit']);
      this.serverRates.current = Number(resp.headers?.['x-ratelimit-remaining']);
      if (resp.headers?.['x-ratelimit-reset']) {
        this.serverRates.reset = new Date(Number(`${resp.headers?.['x-ratelimit-reset']}000`));
      }
      this.serverRates.updatedAt = new Date();
    }
    return resp;
  }
}

function toMonthDate(month: { year: number; month: number }) {
  return `${month.year}${month.month.toString().padStart(2, '0')}`;
}

function toDayDate(date: { year: number; month: number; day?: number }) {
  return date.day
    ? `${toMonthDate(date)}${date.day.toString().padStart(2, '0')}`
    : toMonthDate(date);
}
