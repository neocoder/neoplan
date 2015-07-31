var _ = require('lodash'),
	mongo = require('mongoskin'),
	toObjectID = mongo.helper.toObjectID,
	humanInterval = require('human-interval'),
	util = require('util'),
	async = require('async'),
	EventEmitter = require('events').EventEmitter,
	debug = require('debug')('intime');

function Jobs(opts) {
	var self = this;

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

	this._db = mongo.db(this.options.url, {w: 0});

	this.col = this._db.collection(this.options.collection);

	function scan() {
		self.options.nextScanAt = new Date( Date.now() + self.options.scanInterval );
		setTimeout(function(){
			self._processJobs(scan);
		}, self.options.scanInterval);		
	}

	scan();
}

util.inherits(Jobs, EventEmitter);

var jp = Jobs.prototype;

// for debug only

jp._dropCollection = function(done) {
	this.col.drop(function(err){
		// we ignore the "collection does not exists" error
		if ( done ) {
			done();	
		}		
	});
};

jp.defineJob = function(jobName, processor) {
	if ( this.jobProcessors[jobName] ) {
		this.emit('error', new Error('Job processor with the name '+jobName+' already exists.'));
	} else {
		this.jobProcessors[jobName] = processor;	
	}	
};
 
jp.schedule = function(time, jobName, data, done) {
	var self = this;
	data = data || {};
	done = done || function(){};

	self.remove(jobName, data, function(err){
		if ( err ) { return self.emit('error', err); }

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

		self.col.insert({
			name: jobName,
			data: data,

			status: 'scheduled', // 'pending', 'processing', 'done', 'scheduled'

			nextRunAt: nextRun
		}, function(err){
			if ( err ) { return self.emit('error', err); }
		});

	});
};

jp.every = function(time, jobName, data, done) {
	var self = this;
	data = data || {};
	done = done || function(){};

	self.remove(jobName, data, function(err){
		if ( err ) { return self.emit('error', err); }

		var parsedInterval = humanInterval(time);

		var nextRun = new Date(Date.now() + parsedInterval);

		debug('scheduling %s for %s ( %s )', jobName, nextRun, nextRun.getTime());

		self.col.insert({
			name: jobName,
			data: data,

			intervalStr: time,
			interval: parsedInterval,
			status: 'scheduled', // 'pending', 'processing', 'done', 'scheduled'

			nextRunAt: nextRun
		}, function(err){
			if ( err ) { self.emit('error', err); return done(err); }
			done(null, { intervalMs: parsedInterval, nextRun: nextRun });
		});
	});
};

jp.remove = function(jobName, dataMatcher, done) {
	done = done || function(){};
	dataMatcher = dataMatcher || {};

	this.col.remove({
		name: jobName,
		data: dataMatcher
	}, done);
};

jp.lockAndGetNextJob = function(done) {
	var self = this;
	var now = new Date(),
		lockDeadline = new Date(Date.now().valueOf() - this.options.lockLifetime);

	debug('looking for jobs with nextRunAt <= %s, ( %s )', this.options.nextScanAt, this.options.nextScanAt.getTime());

	var availableProcessors = Object.getOwnPropertyNames(this.jobProcessors);

	this.col.findAndModify({
		nextRunAt: { $lte: this.options.nextScanAt },

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
			workerId: this.options.workerId,
			status: 'processing'
		}
	},
	{ 'new': true },
	done);
};

jp.lockAndGetNextBatch = function(done) {
	var self = this,
		batch = [];

	function nextJob() {
		self.lockAndGetNextJob(function(err, job){
			if ( err ) { return done(err); }

			if ( job ) {
				batch.push(job);
			}
			// if no more jobs or reached concurrecy limit
			if ( !job || batch.length == self.options.concurrency ) {
				done(null, batch);
			} else {
				nextJob();
			}
		});
	}

	nextJob();
};

jp._processJobs = function(done) {
	var self = this;

	self.lockAndGetNextBatch(function(err, batch){
		if ( err ) { return done(err); }

		debug('lockAndGetNextBatch %s', batch.length);

		if (batch && batch.length) {
			async.each(batch, function(job, next){

				if ( self.jobProcessors[job.name] ) {
					self.jobProcessors[job.name](job.data, function(err){
						if ( err ) { return next(err); }

						// if recurring job
						if ( job.interval ) {
							debug('Re-Scheduling JOB !!!!!!!!!!!!!!!!')
							self.col.update({
								_id: job._id
							}, {
								$set: {
									status: 'scheduled',
									nextRunAt: new Date( Date.now() + job.interval ),
									lockedAt: null,
									workerId: null
								}
							}, function(err){
								if ( err ) { return next(err); }
								next();
							});
						} else {
							self.col.update({ _id: job._id }, { $set: { status: 'done', lockedAt: null } }, function(err){
								if ( err ) { return next(err); }
								next();
							});
						}
					});
				} else {
					self.emit('error', new Error('Job with the name '+job.name+' does not have a processor.'));
					next();
				}

			}, function(err){
				if ( err ) { return self.emit('error', err); }
				done(err);
			});
		} else {
			done();
		}
	});
};

jp.close = function() {
	this._db.close();
};

module.exports = Jobs;