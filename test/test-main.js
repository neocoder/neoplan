var expect = require('chai').expect;
var _ = require('lodash');
var Jobs = require('../');
var debug = require('debug')('neoplan');

var humanInterval = require('human-interval');


/*
var iit = it;
it = function(){};
//*/

/**
 * scanInterval is defined in this test to make them run faster.
 * Usuallay you should not change this value
 */

var mongoPath = process.env.MONGOPATH || 'mongodb://localhost:27017/neoplan';
var opts = { url: mongoPath };
var J = new Jobs(_.extend({ collection: 'jobs-test' }, opts));

J.on('error', function(err){
	debug('[JOBS ERROR] '+err);
});


beforeEach(function(done){
	J._clearJobProcessors();
	J._dropCollection(done);
})

describe('Testing jobs', function(){

	this.timeout(0);

	// it('should create jobs object and wait for error and reconnection', function(done){
	// 	jobs = new Jobs(_.extend({ collection: 'jobs-test-1' }, opts));
	//
	// 	jobs.on('error', function(err){
	// 		console.log('TEST jobs on error handler: ', err);
	// 	});
	// 	expect(jobs).to.be.an.instanceOf(Jobs);
	// 	//jobs._dropCollection(done);
	// 	//return true;
	// });

	//*

	it('should create jobs object', function(done){
		expect(J).to.be.an.instanceOf(Jobs);
		done();
	});

	it('should fetch jobs empty batch', function(done){
		J.lockAndGetNextBatch(function(err, jobsBatch){
			if (err) { return done(err); }

			expect(jobsBatch).to.be.instanceOf(Array);
			expect(jobsBatch).to.have.length(0);

			done();
		});
	});



	it('should add a single scheduled job', function(testDone){

		J.defineJob('test', function(data, done){
			done();
			testDone();
		});

		J.schedule('in 1 seconds', 'test', { hello: 'world' });

		return true;
	});


	it('should scheduled 2 jobs', function(testDone){

		var x = 0;

		function check() {
			if ( x == 2 ) {
				testDone();
			}
		}

		J.defineJob('test1', function(data, done){
			debug('test1 processed!');
			x += 1;
			done();
			check();
		});

		J.defineJob('test2', function(data, done){
			debug('test2 processed!');
			x += 1;
			done();
			check();
		});

		J.schedule('2 seconds', 'test2', { hello: 'world' });
		J.schedule('4 seconds', 'test1', { hello: 'world' });

		return true;
	});


	it('should add a single job, schedule it 10 times and process in 2 batches', function(testDone){

		// J = new Jobs(_.extend({
		// 	collection: 'jobs-test-5',
		// 	scanInterval: 1000
		// }, opts));

		var x = 0;

		function check() {
			if ( x == 10 ) {
				testDone();
			}
		}

		J.defineJob('test', function(data, done){
			debug('job %s executed at %s', data.hello, Date.now());
			debug('test processed! hello %s ', data.hello);
			x += 1;
			done();
			check();
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


		return true;
	});

	it('should add a single recurring job, and remove it after 5 runs', function(testDone){

		var x = 0;

		function check() {
			if ( x > 3 ) {
				J.remove('test', { hello: 'world' });
				setTimeout(function() {
					expect(x).to.be.equal(4);
					testDone();
				}, 2000);

			}
		}

		J.defineJob('test', function(data, done){
			debug('running TEST job %s time', x);
			x += 1;
			done();
			check();
		});

		J.every('1 seconds', 'test', { hello: 'world' });

		return true;
	});

	it('should add a single recurring job, schedule and reschedule it for a later time', function(testDone){
		var x = 0;
		var t;

		function check() {
			expect(x).to.be.equal(1);
			testDone();
		}

		J.defineJob('test', function(data, done){
			x += 1;
			debug('running TEST job %s time', x);
			done();
			clearTimeout(t);
			check();
		});

		J.schedule('in 1 seconds', 'test', { hello: 'world' }, function(){
			J.schedule('in 3 seconds', 'test', { hello: 'world' }, function(){
				t = setTimeout(check, 4000);
			});
		});

		return true;
	});

	it('should run 10 jobs with 1 resulting in error and continue processing', function(testDone){
		this.timeout(15000);

		var x = 0;

		function check() {
			debug('check x = %s', x);
			if ( x == 10 ) {
				testDone();
			}
		}

		J.defineJob('test', function(data, done){
			x += 1;
			if ( data.hello === 'FAIL' ) {
				return done(new Error('FAIL'));
			}
			debug('job %s executed at %s', data.hello, Date.now());
			debug('test processed! hello %s ', data.hello);
			done();
			check();
		});

		J.schedule('2 seconds', 'test', { hello: 'world 1' });
		J.schedule('2 seconds', 'test', { hello: 'world 2' });
		J.schedule('2 seconds', 'test', { hello: 'world 3' });
		J.schedule('2 seconds', 'test', { hello: 'FAIL' });
		J.schedule('2 seconds', 'test', { hello: 'world 5' });
		J.schedule('2 seconds', 'test', { hello: 'world 6' });
		J.schedule('2 seconds', 'test', { hello: 'world 7' });
		J.schedule('2 seconds', 'test', { hello: 'world 8' });
		J.schedule('2 seconds', 'test', { hello: 'world 9' });
		J.schedule('2 seconds', 'test', { hello: 'world 10' });

		return true;

	});


	it('should continue processing after 1 job timed out', function(testDone){
		this.timeout(45000);

		J.defineJob('test', function(data, done){
			debug('Processing %s', data.x);

			if ( data.x == 'TIMEOUT' ) { return; }

			if ( data.x == 'VENUS' ) { testDone(); }

			done();
		});

		J.schedule('2 seconds', 'test', { x: 'TIMEOUT' });
		J.schedule('2 seconds', 'test', { x: 'SUN' });
		J.schedule('2 seconds', 'test', { x: 'MERCURY' });
		J.schedule('30 seconds', 'test', { x: 'VENUS' });

		return true;
	});

	it('should run job immidiately', function(testDone){
		this.timeout(45000);

		J.defineJob('test', function(data, done){
			testDone();
		});

		J.now('test');

		return true;
	});

	it('should adjust job timeout', function(testDone){
		this.timeout(10000);
		var jobTimeout = 5000;

		J.once('job-late', function(jobName, data){
			expect(data.timeout).to.be.equal(jobTimeout);
			testDone();
		});

		J.defineJob('test', function(data, done){
			setTimeout(function () {
				done();
			}, 7500);
		}, { timeout: jobTimeout });

		J.now('test');

		return true;
	});

	//*/

});
