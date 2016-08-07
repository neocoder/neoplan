var _ = require('lodash'),
	MongoClient = require('mongodb').MongoClient,
	humanInterval = require('human-interval'),
	util = require('util'),
	async = require('async'),
	EventEmitter = require('events').EventEmitter,
	debug = require('debug')('intime');

function Jobs(opts) {
	var that = this;

	that._ready = false;

	EventEmitter.call(this);

	this.jobProcessors = {};

	this.options = _.extend({
		workerId: 0,
		url: 'mongodb://localhost:27017/intime',
		collection: 'jobs',
		lockLifetime: 10 * 60 * 1000, //10 minute default lockLifetime
		concurrency: 10, // Process n jobs at a time ( lock & get )
		scanInterval: 2000, // 2 sec
		nextScanAt: new Date(Date.now() + 5000) // in 5 seconds
	}, opts || {});

	this.ready = function(cb) {
		if ( this._ready ) {
			cb();
		} else {
			this.on('ready', cb);
		}
	};

	this.connect();
}

util.inherits(Jobs, EventEmitter);

var jp = Jobs.prototype;

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

	that.options.nextScanAt = new Date( Date.now() + that.options.scanInterval );
	setTimeout(function(){
		that._processJobs(that._scanForJobs.bind(that));
	}, that.options.scanInterval);
}

jp.connect = function(reconnect) {
	var that = this;
	debug('Connecting to '+that.options.url);
	MongoClient.connect(that.options.url, function(err, db){
		if ( err ) { throw err; /*return that.emit('error', err);*/ }

		that._db = db;
		that.col = db.collection(that.options.collection);
		debug('Selecting collection: '+that.options.collection);
		if ( !reconnect ) {
			that._ready = true;
			that.emit('ready');
		}
		that._scanForJobs();
	});
}

jp.defineJob = function(jobName, processor) {
	var that = this;

	this.ready(function(){
		if ( that.jobProcessors[jobName] ) {
			that.emit('error', new Error('Job processor with the name '+jobName+' already exists.'));
		} else {
			that.jobProcessors[jobName] = processor;
		}
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
				throw new Error('[Jobs.schedule] wrong time argument %s', time);
			}

			debug('scheduling %s for %s ( %s )', jobName, nextRun, nextRun.getTime());

			that.col.insert({
				name: jobName,
				data: data,

				status: 'scheduled', // 'pending', 'processing', 'done', 'scheduled'

				nextRunAt: nextRun
			}, function(err){
				if ( err ) { that.emit('error', err); return done(err); }
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

	//ECONNREFUSED
	//ECONNREFUSED

	that.ready(function(){
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
						var ext = {};
						if ( err ) {
							lastError = 'Job error ['+job.name+']: '+err.message;
							ext.lastError = lastError;
							that.emit('error', new Error(lastError));
						}

						// if recurring job
						if ( job.interval ) {
							debug('Re-Scheduling JOB !!!!!!!!!!!!!!!!');
							that.col.update({
								_id: job._id
							}, {
								$set: _.extend({
									status: 'scheduled',
									nextRunAt: new Date( Date.now() + job.interval ),
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

					var jobTimeout = 20000; // 20 sec
					var jobDoneCalled = false;
					var jobStarted = Date.now();

					var jobTimeout = setTimeout(function () {
						jobDoneCalled = true;
						that.emit('error', new Error('Job error ['+job.name+']: timeout. job data: '+JSON.stringify(job.data)));
						jobDoneCallback();
					}, jobTimeout);

					// try {
						that.jobProcessors[job.name](job.data, function(err){
							var jobTimeLapsed = Date.now()-jobStarted;
							if ( jobTimeout ) { clearTimeout(jobTimeout); }
							if ( jobDoneCalled ) {
								that.emit('error', new Error('Job error ['+job.name+']: Job took '+jobTimeLapsed+'ms to run. But callback was called on timeout in '+jobTimeout+'ms.'));
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
	});
};

jp.close = function() {
	that.ready(function(){
		that._db.close();
	});
};

module.exports = Jobs;
