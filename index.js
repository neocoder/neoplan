const { MongoClient } = require('mongodb');
const humanInterval = require('human-interval');
const EventEmitter = require('events');
const debug = require('debug')('neoplan');
const async = require('async');

const TASK_STATUS_PROCESSING = 'processing';
const TASK_STATUS_DONE = 'done';
const TASK_STATUS_ERROR = 'error';
const TASK_STATUS_SCHEDULED = 'scheduled';

const EV_ERROR = 'error';

const FIVE_MINUTES = 5 * 60 * 1000;

const isString = (s) => typeof s === 'string';
const isNumber = (n) => typeof n === 'number' && !Number.isNaN(n);
const isDate = (d) => d instanceof Date && !Number.isNaN(d.valueOf());
class Neoplan extends EventEmitter {
    constructor(opts = {}) {
        super();

        this.options = {
            workerId: 0,
            url: 'mongodb://localhost:27017/neoplan',
            collection: 'jobs',
            lockLifetime: 10 * 60 * 1000, // 10 minute default lockLifetime
            concurrency: 10, // Process n jobs at a time ( lock & get )
            scanInterval: 2000, // 2 sec
            nextScanAt: null, // job processor is not started
            processJobs: true, // if false, current instance will not process jobs, only manage
            ...opts,
        };

        this.dbName = new URL(this.options.url).pathname.replace(/^\//g, '');
        this.jobProcessors = {};
        this.client = new MongoClient(this.options.url);
    }

    async connect() {
        const conn = await this.client.connect();

        this._conn = conn;
        this._db = conn.db(this.dbName);
        this.col = this._db.collection(this.options.collection);
        debug(`Selecting collection: ${this.options.collection}`);
        if (this.options.processJobs) {
            this._scanForJobs();
        }
        return conn;
    }

    _clearJobProcessors() {
        this.jobProcessors = {};
    }

    async _dropCollection() {
        const collections = await this._db.collections();
        const collectionNames = collections.map((col) => col.collectionName);

        if (collectionNames.includes(this.options.collection)) {
            debug('dropping jobs collection');
            return this.col.drop();
        }
        return Promise.resolve();
    }

    async _getJob(jobId) {
        return this.col.findOne({ _id: jobId });
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

    defineJob(jobName, processor, opts = {}) {
        if (this.jobProcessors[jobName]) {
            throw new Error(`Job processor with the name ${jobName} already exists.`);
        } else {
            this.jobProcessors[jobName] = processor;
        }
        this.jobProcessors[jobName].opts = opts;
    }

    /**
     * Create job record
     * @param {Date} time time to run the job
     * @param {String} jobName job name
     * @param {Object} data job data
     */
    async createJobRecord(time, jobName, data = {}, intervalStr = null, interval = null) {
        if (!isDate(time)) {
            throw new Error('Wrong time parameter type. Must be Date');
        }

        const ivProps =
            intervalStr && interval
                ? {
                      intervalStr,
                      interval,
                  }
                : {};

        await this.removeDoneOrScheduled(jobName, data);
        await this.removeDead(jobName, data);

        debug('scheduling %s for %s ( %s )', jobName, time, time.getTime());

        const insertOp = await this.col.insertOne(
            {
                name: jobName,
                data,
                ...ivProps,
                status: TASK_STATUS_SCHEDULED,
                nextRunAt: time,
            },
            { returnDocument: 'after' },
        );

        return this.col.findOne({ _id: insertOp.insertedId });
    }

    async schedule(time, jobName, data = {}) {
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

    now(jobName, data) {
        return this.createJobRecord(new Date(), jobName, data);
    }

    every(time, jobName, data = {}, opts = { runNow: false }) {
        const parsedInterval = humanInterval(time);
        const nextRun = opts.runNow ? new Date() : new Date(Date.now() + parsedInterval);

        return this.createJobRecord(nextRun, jobName, data, time, parsedInterval);
    }

    async remove(jobName, dataMatcher = {}) {
        return this.col.deleteMany({
            name: jobName,
            data: dataMatcher,
        });
    }

    async removeDoneOrScheduled(jobName, dataMatcher = {}) {
        return this.col.deleteMany({
            name: jobName,
            data: dataMatcher,
            status: { $in: [TASK_STATUS_DONE, TASK_STATUS_SCHEDULED] },
        });
    }

    async removeDead(jobName, dataMatcher = {}) {
        const lockDeadline = new Date(Date.now() - this.options.lockLifetime);
        return this.col.deleteMany({
            name: jobName,
            data: dataMatcher,
            status: { $in: [TASK_STATUS_PROCESSING] },
            lockedAt: { $lte: lockDeadline },
        });
    }

    async lockAndGetNextJob() {
        const now = new Date();
        const lockDeadline = new Date(Date.now() - this.options.lockLifetime);

        const availableProcessors = Object.getOwnPropertyNames(this.jobProcessors);

        const { value: job } = await this.col.findOneAndUpdate(
            {
                nextRunAt: { $lte: this.options.nextScanAt },

                $or: [
                    { lockedAt: null },
                    { lockedAt: { $exists: false } },
                    { lockedAt: { $lte: lockDeadline } },
                ],

                status: { $in: [TASK_STATUS_SCHEDULED, TASK_STATUS_PROCESSING] },

                name: { $in: availableProcessors },
            },
            {
                $set: {
                    lockedAt: now,
                    workerId: this.options.workerId,
                    status: TASK_STATUS_PROCESSING,
                },
            },
            { returnDocument: 'after' },
        );
        return job;
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

    async _saveJobError(job, err) {
        return this.col.findOneAndUpdate(
            { _id: job._id },
            {
                $set: {
                    status: TASK_STATUS_ERROR,
                    lastError: err.message,
                },
            },
            { returnDocument: 'after' },
        );
    }

    async _processJobs() {
        const batch = await this.lockAndGetNextBatch();

        debug('lockAndGetNextBatch %s', batch.length);

        if (batch && batch.length) {
            async.each(batch, (job, next) => {
                if (!this.jobProcessors[job.name]) {
                    this._saveJobError(
                        job,
                        new Error(`Job with the name ${job.name} does not have a processor.`),
                    );
                    return next();
                }

                const jobDoneCallback = (err) => {
                    debug(`jobDoneCallback: ${job.name}. err: ${err && err.message}`);
                    if (err) {
                        debug(`Job error [${job.name}]: ${err.message}`);
                        this._saveJobError(job, err);
                        this.emit(EV_ERROR, new Error(`Job error [${job.name}]: ${err.message}`));
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

                        this.col.updateOne(
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
                        this.col.updateOne(
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

                const defaultJobOptions = {
                    timeout: 20000, // 20 sec
                };

                const namedJobOptions = this.jobProcessors[job.name].opts || {};

                const jobOpts = { ...defaultJobOptions, ...namedJobOptions };

                const jobTimeout = jobOpts.timeout;
                let jobDoneCalled = false;
                const jobStarted = Date.now();

                debug(`⌛️ Setting job ${job.name} timeout to ${jobTimeout}`);
                const jt = setTimeout(() => {
                    jobDoneCalled = true;
                    jobDoneCallback(new Error('Job Timeout'));
                }, jobTimeout);

                debug(`🤖 Running job processor ${job.name}`);

                const jobDoneTimeoutHandler = (err) => {
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
                    jobDoneCallback(err);
                };

                const jp = this.jobProcessors[job.name](job.data, jobDoneTimeoutHandler);
                if (jp && jp.then) {
                    jp.then(jobDoneTimeoutHandler).catch(jobDoneTimeoutHandler);
                }
            });
        }
    }

    close() {
        this._stop = true;
        this._conn.close();
    }
}

module.exports = { Neoplan };
