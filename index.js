var _ = require('lodash'),
	MongoClient = require('mongodb').MongoClient,
	humanInterval = require('human-interval'),
	util = require('util'),
	async = require('async'),
	EventEmitter = require('events').EventEmitter,
	debug = require('debug')('neoplan');

function Neoplan(opts) {
	var that = this;

	that._ready = false;

	EventEmitter.call(this);

	this.setMaxListeners(0);

	this.jobProcessors = {};

	this.options = _.extend({
		workerId: 0,
		url: 'mongodb://localhost:27017/neoplan',
		collection: 'jobs',
		lockLifetime: 10 * 60 * 1000, //10 minute default lockLifetime
		concurrency: 10, // Process n jobs at a time ( lock & get )
		scanInterval: 2000, // 2 sec
		nextScanAt: new Date(Date.now() + 5000) // in 5 seconds
	}, opts || {});

	this.dbName = new URL(this.options.url).pathname.replace(/^\//g,'');

	this.ready = function(cb) {
		if ( this._ready ) {
			cb();
		} else {
			this.once('ready', cb);
		}
	};

	this.connect();
}

util.inherits(Neoplan, EventEmitter);

var jp = Neoplan.prototype;

// for debug only

jp._clearJobProcessors = function() {
	this.jobProcessors = {};
}

jp._dropCollection = function(done) {
	var that = this;
	this.ready(function(){
		that.col.drop(function(err){
			// we ignore the "collection does not exists" error
			if ( done ) {
				done();
			}
		});
	});
};

jp._scanForJobs = function(err) {
	var that = this;
	if ( this._stop ) {
		debug('Stopping scan loop. _stop flag raised');
		return;
	}

	that.options.nextScanAt = new Date( Date.now() + that.options.scanInterval );
	setTimeout(function(){
		that._processJobs(that._scanForJobs.bind(that));
	}, that.options.scanInterval);
}

jp.connect = function(reconnect) {
	debug('Connecting to '+this.options.url);
	MongoClient.connect(this.options.url, (err, conn) => {
		if ( err ) {
			if (err.message.includes('ECONNREFUSED')) {
				const errCount = this.errCount ? this.errCount + 1 : 1;
				setTimeout(() => {
					this.connect();
				}, errCount * 1000)
				return;
			}
			return this.emit('error', err);
		}

		this._conn = conn;
		this._db = conn.db(this.dbName);
		this.col = this._db.collection(this.options.collection);
		debug('Selecting collection: '+this.options.collection);
		if ( !reconnect && !this._ready ) {
			this._ready = true;
			this.emit('ready');
		}
		this._scanForJobs();
	});
}

jp.defineJob = function(jobName, processor, opts = {}) {
	var that = this;

	this.ready(function(){
		if ( that.jobProcessors[jobName] ) {
			that.emit('error', new Error('Job processor with the name '+jobName+' already exists.'));
		} else {
			that.jobProcessors[jobName] = processor;
		}
		that.jobProcessors[jobName].opts = opts;
	});
};

jp.schedule = function(time, jobName, data, done) {
	var that = this;

	data = data || {};
	done = done || function(){};

	that.ready(function(){
		that.remove(jobName, data, function(err){
			if ( err ) { return that.emit('error', err); }

			var nextRun;

			if ( _.isString(time) ) {
				parsedInterval = humanInterval(time);
				nextRun = new Date(Date.now() + parsedInterval);
			} else if ( _.isNumber(time) ) {
				nextRun = new Date(Date.now() + time);
			} else if ( _.isDate(time) ) {
				// TODO: add
				nextRun = time;
			} else {
				throw new Error('[Neoplan.schedule] wrong time argument %s', time);
			}

			debug('scheduling %s for %s ( %s )', jobName, nextRun, nextRun.getTime());

			that.col.insert({
				name: jobName,
				data: data,

				status: 'scheduled', // 'pending', 'processing', 'done', 'scheduled'

				nextRunAt: nextRun
			}, function(err){
				//TODO: test the done function call on err and success
				if ( err ) { that.emit('error', err); }
				return done(err);
			});

		});
	});
};

jp.now = function(jobName, data, done) {
	var that = this;

	data = data || {};
	done = done || function(){};

	that.ready(function(){
		that.remove(jobName, data, function(err){
			if ( err ) { return that.emit('error', err); }

			var nextRun = new Date();

			debug('scheduling %s for %s ( %s )', jobName, nextRun, nextRun.getTime());

			that.col.insert({
				name: jobName,
				data: data,

				status: 'scheduled', // 'pending', 'processing', 'done', 'scheduled'

				nextRunAt: nextRun
			}, function(err){
				if ( err ) { that.emit('error', err); }
				return done(err);
			});

		});
	});
};

jp.every = function(time, jobName, data, opts, done) {
	var that = this;
	data = data || {};
	done = done || function(){};
	opts = opts || {};

	if ( _.isFunction(opts) ) {
		done = opts;
		opts = {
			runNow: false
		};
	}

	that.ready(function(){
		that.remove(jobName, data, function(err){
			if ( err ) { return that.emit('error', err); }

			var parsedInterval = humanInterval(time);

			var nextRun = opts.runNow ? new Date() : new Date(Date.now() + parsedInterval);

			debug('scheduling %s for %s ( %s )', jobName, nextRun, nextRun.getTime());

			that.col.insert({
				name: jobName,
				data: data,

				intervalStr: time,
				interval: parsedInterval,
				status: 'scheduled', // 'pending', 'processing', 'done', 'scheduled'

				nextRunAt: nextRun
			}, function(err){
				if ( err ) { that.emit('error', err); return done(err); }
				done(null, { intervalMs: parsedInterval, nextRun: nextRun });
			});
		});
	});
};

jp.remove = function(jobName, dataMatcher, done) {
	var that = this;
	done = done || function(){};
	dataMatcher = dataMatcher || {};

	that.ready(function(){
		that.col.remove({
			name: jobName,
			data: dataMatcher
		}, done);
	});
};

jp.lockAndGetNextJob = function(done) {
	var that = this;

	that.ready(function(){
		var now = new Date(),
			lockDeadline = new Date(Date.now().valueOf() - that.options.lockLifetime);

		debug('looking for jobs with nextRunAt <= %s, ( %s )', that.options.nextScanAt, that.options.nextScanAt.getTime());

		var availableProcessors = Object.getOwnPropertyNames(that.jobProcessors);

		that.col.findAndModify({
			nextRunAt: { $lte: that.options.nextScanAt },

			$or: [
				{ lockedAt: null },
				{ lockedAt: { $exists: false } },
				{ lockedAt: { $lte: lockDeadline } }
			],

			status: { $ne: 'done' },

			name: { $in: availableProcessors }
		},
		{ /* sorting params */ },
		{
			$set: {
				lockedAt: now,
				workerId: that.options.workerId,
				status: 'processing'
			}
		},
		{ 'new': true },
		function(err, res){
			if ( err ) { return done(err); }
			done(null, res.value);
		});
	});
};

jp.lockAndGetNextBatch = function(done) {
	var that = this,
		batch = [];

	that.ready(function(){
		function nextJob() {
			that.lockAndGetNextJob(function(err, job){
				if ( err ) { return done(err); }

				if ( job ) {
					batch.push(job);
				}

				// if no more jobs or reached concurrecy limit
				if ( !job || batch.length == that.options.concurrency ) {
					done(null, batch);
				} else {
					nextJob();
				}
			});
		}

		nextJob();
	});
};

jp._processJobs = function(done) {
	var that = this;

	that.lockAndGetNextBatch(function(err, batch){
		if ( err ) { return done(err); }

		debug('lockAndGetNextBatch %s', batch.length);

		if (batch && batch.length) {
			async.each(batch, function(job, next){

				if ( !that.jobProcessors[job.name] ) {
					that.emit('error', new Error('Job with the name '+job.name+' does not have a processor.'));
					return next();
				}

				var jobDoneCallback = function(err){
					var lastError = '';
					var ext = {
						lastError: ''
					};
					if (err) {
						lastError = 'Job error ['+job.name+']: '+err.message;
						ext.lastError = lastError;
						that.emit('error', new Error(lastError));
					}

					// if recurring job
					if ( job.interval ) {
						debug('Re-Scheduling JOB !!!!!!!!!!!!!!!!');
						let nextRun = new Date(Date.now() + job.interval);
						let errorCount = 0;
						let inter = 5 * 60 * 1000;

						if (lastError) {
							errorCount = job.errCounter ? job.errCounter + 1 : 1;

							if (job.interval > inter) {
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
										nextRun = new Date(Date.now() + job.interval);
								}
							}
						}

						that.col.update({
							_id: job._id
						}, {
							$set: _.extend({
								status: 'scheduled',
								nextRunAt: nextRun,
								errCounter: errorCount,
								lockedAt: null,
								workerId: null
							}, ext)
						}, next);
					} else {
						that.col.update({
							_id: job._id
						}, {
							$set: _.extend({ status: 'done', lockedAt: null }, ext)
						}, next);
					}
				};

				const defaultJobOptions = {
					timeout: 20000 // 20 sec
				};

				const namedJobOptions = that.jobProcessors[job.name].opts || {};

				var jobOpts = Object.assign({}, defaultJobOptions, namedJobOptions);

				var jobTimeout = jobOpts.timeout;
				var jobDoneCalled = false;
				var jobStarted = Date.now();

				debug(`⌛️ Setting job ${job.name} timeout to ${jobTimeout}`);
				var jt = setTimeout(function () {
					jobDoneCalled = true;
					that.emit('error', new Error('Job error ['+job.name+']: timeout. job data: ' + JSON.stringify(job.data)));
					that.emit('timeout', job.name, job.data, jobTimeout);
					jobDoneCallback();
				}, jobTimeout);

				debug(`🤖 Running job processor ${job.name}`);
				// try {
					that.jobProcessors[job.name](job.data, function(err){
						var jobTimeLapsed = Date.now()-jobStarted;
						if ( jt ) { clearTimeout(jt); }
						if ( jobDoneCalled ) {
							that.emit('error', new Error(`Job error [${job.name}] (id: ${job._id}): Job took ${jobTimeLapsed}ms to run. But callback was called on timeout in ${jobTimeout}ms. job data: ${JSON.stringify(job.data)}`));
							that.emit('job-late', job.name, { elapsed: jobTimeLapsed, timeout: jobTimeout  });
							return;
						}
						jobDoneCallback(err);
					});
				// } catch(e) {
				// 	jobDoneCallback(e);
				// }


			}, function(err){
				if ( err ) { that.emit('error', err); }
				done(err);
			});
		} else {
			done();
		}
	});
};

jp.close = function() {
	this.ready(() =>{
		this._stop = true;
		this._conn.close();
	});
};

module.exports = Neoplan;
