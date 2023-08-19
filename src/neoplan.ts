import mongoose, { Model, model, Types } from 'mongoose';

import humanInterval from 'human-interval';
import EventEmitter from 'events';
import createDebug from 'debug';
import async from 'async';

import { Options, Job, Processor, timestamp } from './types';

import getSchema, { IJob } from './jobSchema';
import { DeleteResult } from 'mongodb';

const debug = createDebug('neoplan');

const TASK_STATUS_PROCESSING = 'processing';
const TASK_STATUS_DONE = 'done';
const TASK_STATUS_ERROR = 'error';
const TASK_STATUS_SCHEDULED = 'scheduled';

const EV_ERROR = 'error';

const FIVE_MINUTES = 5 * 60 * 1000;

const isString = (s: any) => typeof s === 'string';
const isNumber = (n: any) => typeof n === 'number' && !Number.isNaN(n);
const isDate = (d: any) => d instanceof Date && !Number.isNaN(d.valueOf());

const MODEL_CACHE = new Map<string, Model<IJob>>();

export class Neoplan extends EventEmitter {
    options: Options;
    _scanTimeout: NodeJS.Timeout;
    _stop: boolean;
    dbName: string;
    jobProcessors: Array<Job> = [];
    client: any;
    Job: Model<IJob>;

    constructor(opts: Options = {}) {
        super();

        this.options = {
            workerId: 0,
            url: 'mongodb://localhost:27017/neoplan',
            collection: 'jobs',
            modelName: 'Job',
            lockLifetime: 10 * 60 * 1000, // 10 minute default lockLifetime
            concurrency: 10, // Process n jobs at a time ( lock & get )
            scanInterval: 2000, // 2 sec
            nextScanAt: null, // job processor is not started
            processJobs: true, // if false, current instance will not process jobs, only manage
            ...opts,
        };

        const modelCacheKey = `${this.options.collection}-${this.options.modelName}`;

        if (MODEL_CACHE.has(modelCacheKey)) {
            this.Job = MODEL_CACHE.get(modelCacheKey);
        } else {
            this.Job = model<IJob>(this.options.modelName, getSchema(this.options.collection));
            MODEL_CACHE.set(modelCacheKey, this.Job);
        }

        this.dbName = new URL(this.options.url).pathname.replace(/^\//g, '');
    }

    async connect() {
        const conn = mongoose.connect(this.options.url);

        conn.then(() => {
            debug(`::.:: Connected to DB ${this.options.url}!`);
            if (this.options.processJobs) {
                this._scanForJobs();
            }
        });

        return conn;
    }

    _clearJobProcessors() {
        this.jobProcessors = [];
    }

    async _dropCollection() {
        debug(`dropping ${this.options.collection} collection`);

        let list = await this.Job.db.db
            .listCollections({
                name: this.Job.collection.name,
            })
            .toArray();

        if (list.length !== 0) {
            return this.Job.collection.drop().then(() => {
                debug(`collection dropped`);
            });
        } else {
            debug(`collection ${this.Job.collection.name} does not exist`);
        }
    }

    async _getJob(jobId: Types.ObjectId) {
        return this.Job.findOne({ _id: jobId });
    }

    _scanForJobs() {
        if (this._stop) {
            debug('Stopping scan loop. _stop flag raised');
            this.options.nextScanAt = null;
            return;
        }

        this.options.nextScanAt = new Date(Date.now() + this.options.scanInterval);

        this._scanTimeout = setTimeout(async () => {
            await this._processJobs();
            this._scanForJobs();
        }, this.options.scanInterval);
    }

    startJobsProcessing() {
        this._stop = false;
        if (this.options.nextScanAt) {
            debug('Jobs processing already running');
            return;
        }

        this._scanForJobs();
    }

    stopJobsProcessing() {
        this._stop = true;
        this.options.nextScanAt = null;
        if (this._scanTimeout) {
            clearTimeout(this._scanTimeout);
        }
    }

    public defineJob(name: string, processor: Processor, opts: any = {}) {
        const exists = this.jobProcessors.find((j) => j.name === name);
        if (exists) {
            throw new Error(`Job processor with the name ${name} already exists.`);
        } else {
            debug(`Job definition ${name} is added`);
            this.jobProcessors.push({
                name,
                processor,
                opts,
            });
        }
    }

    getJobDefinition(name: string): null | Job {
        return this.jobProcessors.find((j) => j.name === name);
    }

    /**
     * Create job record
     * @param {Date} time time to run the job
     * @param {String} name job name
     * @param {Object} data job data
     */
    async createJobRecord(
        time: Date,
        name: string,
        data: any = {},
        intervalStr: string = null,
        interval: number = null,
    ) {
        debug(`[createJobRecord()] data: ${JSON.stringify(data)}`);
        if (!isDate(time)) {
            throw new Error('Wrong time parameter type. Must be Date');
        }

        await this.removeDoneOrScheduled(name, data);
        await this.removeDead(name, data);

        debug(
            `scheduling ${name}:${JSON.stringify(
                data,
            )} for ${time}(${time.getTime()}). Interval: (${interval}), IntervalStr: (${intervalStr})`,
        );

        return new this.Job({
            name,
            data,
            intervalStr,
            interval,
            status: TASK_STATUS_SCHEDULED,
            nextRunAt: time,
        }).save();
    }

    /**
     * Find jobs that are in processing or scheduled state
     * @param {String} name job name
     * @param {Object} data job data
     */
    async findActiveJobs(name: string, data: any = {}) {
        if (!name) {
            throw new Error('Pease provide job name');
        }
        debug(`Data: ${JSON.stringify(data)}`);
        return this.Job.find({
            name,
            data,
            status: { $in: [TASK_STATUS_SCHEDULED, TASK_STATUS_PROCESSING] },
        });
    }

    /**
     * Find jobs that are in processing or scheduled state
     * @param {String} name job name
     * @param {Object} data job data
     */
    async findErrorJobs(name: string, data: any = {}) {
        if (!name) {
            throw new Error('Pease provide job name');
        }
        return this.Job.find({
            name,
            data,
            status: TASK_STATUS_ERROR,
        });
    }

    async schedule(time: timestamp, jobName: string, data: any): Promise<IJob>;
    async schedule(time: string, jobName: string, data: any): Promise<IJob>;
    async schedule(time: Date, jobName: string, data: any): Promise<IJob>;

    async schedule(time: any, jobName: string, data: any = {}) {
        let nextRun;

        if (isString(time)) {
            const parsedInterval = humanInterval(time);
            nextRun = new Date(Date.now() + parsedInterval);
        } else if (isNumber(time)) {
            nextRun = new Date(Date.now() + time);
        } else if (isDate(time)) {
            nextRun = time;
        } else {
            throw new Error(`Wrong time argument ${time}`);
        }

        return this.createJobRecord(nextRun, jobName, data);
    }

    async now(jobName: string, data: any = {}): Promise<IJob> {
        debug(`[now()] data: ${JSON.stringify(data)}`);
        return this.createJobRecord(new Date(), jobName, data);
    }

    async every(time: string, jobName: string, data = {}, opts = { runNow: false }): Promise<IJob> {
        const parsedInterval = humanInterval(time);
        const nextRun = opts.runNow ? new Date() : new Date(Date.now() + parsedInterval);

        return this.createJobRecord(nextRun, jobName, data, time, parsedInterval);
    }

    async remove(jobName: string, dataMatcher: any = {}): Promise<any> {
        return this.Job.deleteMany({
            name: jobName,
            data: dataMatcher,
        });
    }

    async removeDoneOrScheduled(name: string, dataMatcher: any = {}): Promise<DeleteResult> {
        return this.Job.deleteMany({
            name,
            data: dataMatcher,
            status: { $in: [TASK_STATUS_DONE, TASK_STATUS_SCHEDULED] },
        });
    }

    async removeErrors(name: string, dataMatcher: any = {}): Promise<DeleteResult> {
        return this.Job.deleteMany({
            name,
            data: dataMatcher,
            status: TASK_STATUS_ERROR,
        });
    }

    async removeDead(name: string, dataMatcher: any = {}): Promise<DeleteResult> {
        const lockDeadline = new Date(Date.now() - this.options.lockLifetime);
        return this.Job.deleteMany({
            name,
            data: dataMatcher,
            status: { $in: [TASK_STATUS_PROCESSING] },
            lockedAt: { $lte: lockDeadline },
        });
    }

    async lockAndGetNextJob() {
        const now = new Date();
        const lockDeadline = new Date(Date.now() - this.options.lockLifetime);

        const availableProcessors = this.jobProcessors.map(({ name }) => name);

        return this.Job.findOneAndUpdate(
            {
                nextRunAt: { $lte: this.options.nextScanAt },

                $or: [
                    { lockedAt: null },
                    { lockedAt: { $exists: false } },
                    { lockedAt: { $lte: lockDeadline } },
                ],

                status: { $in: [TASK_STATUS_SCHEDULED] },

                name: { $in: availableProcessors },
            },
            {
                $set: {
                    lockedAt: now,
                    workerId: this.options.workerId,
                    status: TASK_STATUS_PROCESSING,
                },
            },
            {
                new: true,
            },
        );
    }

    async lockAndGetNextBatch() {
        const batch = [];

        // TODO: optimize for small batches < concurrency
        for (let i = 0; i < this.options.concurrency; i++) {
            batch.push(this.lockAndGetNextJob());
        }
        const resolvedJobs = await Promise.all(batch);

        // filtering null
        return resolvedJobs.filter(Boolean);
    }

    async _saveJobError(job: IJob, err: Error) {
        return this.Job.findOneAndUpdate(
            { _id: job._id },
            {
                $set: {
                    status: TASK_STATUS_ERROR,
                    lastError: err.message,
                },
            },
            { new: true },
        );
    }

    async _processJobs() {
        const batch = await this.lockAndGetNextBatch();

        debug(`LOCKED ${batch.length} JOBS TO PROCESS`);

        batch.forEach((j) => {
            debug(`J:${j._id}/${j.name}`);
        });

        if (batch && batch.length) {
            async.each(batch, (job: IJob, next) => {
                const jobDefinition = this.getJobDefinition(job.name);
                if (!jobDefinition) {
                    this._saveJobError(
                        job,
                        new Error(`Job with the name ${job.name} does not have a processor.`),
                    );
                    return next();
                }

                const jobDoneCallback = (err: Error) => {
                    debug(`jobDoneCallback: ${job.name}. err: ${err && err.message}`);
                    if (err) {
                        debug(`Job error [${job.name}]: ${err.message}`);
                        this._saveJobError(job, err);
                        this.emit(EV_ERROR, err);
                    }

                    // if recurring job
                    if (job.interval) {
                        debug('Re-Scheduling JOB !!!!!!!!!!!!!!!!');
                        let nextRun = new Date(Date.now() + job.interval);
                        let errorCount = 0;

                        if (err) {
                            errorCount = job.errCounter ? job.errCounter + 1 : 1;

                            if (job.interval > FIVE_MINUTES) {
                                switch (errorCount) {
                                    case 1:
                                        nextRun = new Date(Date.now() + 5 * 60 * 1000);
                                        break;
                                    case 2:
                                        nextRun = new Date(Date.now() + 15 * 60 * 1000);
                                        break;
                                    case 3:
                                        nextRun = new Date(Date.now() + 30 * 60 * 1000);
                                        break;
                                    default:
                                        this.emit(
                                            EV_ERROR,
                                            new Error(
                                                `Job ${job.name} failed ${errorCount} times. Will not be re-scheduled.`,
                                            ),
                                        );
                                        nextRun = null;
                                }
                            }
                        }

                        this.Job.updateOne(
                            {
                                _id: job._id,
                            },
                            {
                                $set: {
                                    status:
                                        err && !nextRun ? TASK_STATUS_ERROR : TASK_STATUS_SCHEDULED,
                                    nextRunAt: nextRun,
                                    errCounter: errorCount,
                                    lockedAt: null,
                                    workerId: null,
                                },
                            },
                            next,
                        );
                    } else if (!err) {
                        this.Job.updateOne(
                            {
                                _id: job._id,
                            },
                            {
                                $set: {
                                    status: TASK_STATUS_DONE,
                                    lockedAt: null,
                                    lastError: '',
                                },
                            },
                            next,
                        );
                    }
                };

                const namedJobOptions = jobDefinition.opts || {};

                const jobOpts = {
                    timeout: 20000, // 20 sec
                    ...namedJobOptions,
                };

                const jobTimeout = jobOpts.timeout;
                let jobDoneCalled = false;
                const jobStarted = Date.now();

                debug(`⌛️ Setting job ${job.name} timeout to ${jobTimeout}`);
                const jt = setTimeout(() => {
                    jobDoneCalled = true;
                    jobDoneCallback(new Error('Job Timeout'));
                }, jobTimeout);

                debug(`🤖 Running job processor ${job.name}`);

                const jobDoneTimeoutHandler = (err: any) => {
                    const jobTimeLapsed = Date.now() - jobStarted;
                    if (jt) {
                        clearTimeout(jt);
                    }
                    if (jobDoneCalled) {
                        this._saveJobError(
                            job,
                            new Error(
                                `Job done after timeout. Took ${jobTimeLapsed}ms to run. Timeout: ${jobTimeout}ms`,
                            ),
                        );
                        return;
                    }
                    jobDoneCalled = true;
                    jobDoneCallback(err);
                };

                let jp;
                try {
                    jp = jobDefinition.processor(job.data, jobDoneTimeoutHandler);
                } catch (err: any) {
                    jobDoneTimeoutHandler(err);
                }

                if (jp && jp instanceof Promise) {
                    jp.then(() => {
                        jobDoneTimeoutHandler(null);
                    }).catch(jobDoneTimeoutHandler);
                }
            });
        }
    }

    close() {
        this._stop = true;
        mongoose.connection.close();
    }
}
