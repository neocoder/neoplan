var expect = require('chai').expect;
var _ = require('lodash');
var Jobs = require('../');
var debug = require('debug')('intime');

var humanInterval = require('human-interval');

/**
 * scanInterval is defined in this test to make them run faster.
 * Usuallay you should not change this value
 */

describe('Testing jobs', function(){

	var mongoPath = process.env.MONGOPATH || 'mongodb://localhost:27017/intime';

	var opts = { url: mongoPath };

	//*
	it('should create jobs object', function(done){
		jobs = new Jobs(_.extend({ collection: 'jobs-test-1' }, opts));
		expect(jobs).to.be.an.instanceOf(Jobs);
		jobs._dropCollection(done);
		return true;
	});

	it('should fetch jobs empty batch', function(done){
		jobs = new Jobs(_.extend({ collection: 'jobs-test-2' }, opts));
		jobs.lockAndGetNextBatch(function(err, jobsBatch){
			if (err) { return done(err); }

			expect(jobsBatch).to.be.instanceOf(Array);
			expect(jobsBatch).to.have.length(0);
			jobs._dropCollection(done);
		});
		return true;
	});

	it('should add a single scheduled job', function(testDone){
		this.timeout(4000);

		J = new Jobs(_.extend({
			collection: 'jobs-test-3',
			scanInterval: 500
		}, opts));

		J._dropCollection(function(){
			J.defineJob('test', function(data, done){
				debug('test processed!');
				done();
				J._dropCollection(testDone);
			});

			J.on('error', function(err){
				debug('[JOBS ERROR] '+err);
			});

			J.schedule('in 1 seconds', 'test', { hello: 'world' });
		});


		return true;
	});

	it('should scheduled 2 jobs', function(testDone){
		this.timeout(8000);

		J = new Jobs(_.extend({
			collection: 'jobs-test-4'
		}, opts));

		var x = 0;

		function check() {
			if ( x == 2 ) {
				J._dropCollection(testDone);
			}
		}

		J._dropCollection(function(){
			J.defineJob('test1', function(data, done){
				debug('test1 processed!');
				x += 1;
				check();
				done();				
			});

			J.defineJob('test2', function(data, done){
				debug('test2 processed!');
				x += 1;
				check();
				done();				
			});			

			J.on('error', function(err){
				debug('[JOBS ERROR] '+err);
			});

			J.schedule('2 seconds', 'test2', { hello: 'world' });
			J.schedule('4 seconds', 'test1', { hello: 'world' });
		});


		return true;
	});		

	it('should add a single job, schedule it 10 times and process in 2 batches', function(testDone){
		this.timeout(4000);

		J = new Jobs(_.extend({
			collection: 'jobs-test-5',
			scanInterval: 1000
		}, opts));

		var x = 0;

		function check() {
			if ( x == 10 ) {
				J._dropCollection(testDone);
			}
		}

		J._dropCollection(function(){
			J.defineJob('test', function(data, done){
				debug('job %s executed at %s', data.hello, Date.now());				
				debug('test processed! hello %s ', data.hello);
				x += 1;
				done();
				check();
			});			

			J.on('error', function(err){
				debug('[JOBS ERROR] '+err);
			});

			J.schedule('2 seconds', 'test', { hello: 'world 1' });
			J.schedule('2 seconds', 'test', { hello: 'world 2' });
			J.schedule('2 seconds', 'test', { hello: 'world 3' });
			J.schedule('2 seconds', 'test', { hello: 'world 4' });
			J.schedule('2 seconds', 'test', { hello: 'world 5' });
			J.schedule('2 seconds', 'test', { hello: 'world 6' });
			J.schedule('2 seconds', 'test', { hello: 'world 7' });
			J.schedule('2 seconds', 'test', { hello: 'world 8' });
			J.schedule('2 seconds', 'test', { hello: 'world 9' });
			J.schedule('2 seconds', 'test', { hello: 'world 10' });
		});


		return true;
	});	

	//*/

	it('should add a single recurring job, and remove it after 5 runs', function(testDone){
		this.timeout(10000);

		J = new Jobs(_.extend({
			collection: 'jobs-test-6',
			scanInterval: 500
		}, opts));

		var x = 0;

		function check() {
			if ( x > 3 ) {
				J.remove('test', { hello: 'world' });
				setTimeout(function() {
					expect(x).to.be.equal(4);
					J._dropCollection(testDone);
				}, 2000);
				
			}
		}

		J._dropCollection(function(){
			J.defineJob('test', function(data, done){
				debug('running TEST job %s time', x);
				x += 1;
				done();
				check();
			});			

			J.on('error', function(err){
				debug('[JOBS ERROR] '+err);
			});

			J.every('1 seconds', 'test', { hello: 'world' });
		});


		return true;
	});

	it('should add a single recurring job, schedule and reschedule it for a later time', function(testDone){
		this.timeout(4500);

		J = new Jobs(_.extend({
			collection: 'jobs-test-7',
			scanInterval: 500
		}, opts));

		var x = 0;

		function check() {
			expect(x).to.be.equal(1);
			J._dropCollection(testDone);
		}


		J._dropCollection(function(){
			J.defineJob('test', function(data, done){
				x += 1;
				debug('running TEST job %s time', x);				
				done();
				check();
			});			

			J.on('error', function(err){
				debug('[JOBS ERROR] '+err);
			});

			J.schedule('in 1 seconds', 'test', { hello: 'world' }, function(){
				J.schedule('in 3 seconds', 'test', { hello: 'world' }, function(){
					setTimeout(check, 4000);
				});	
			});
			
		});


		return true;
	});	

});