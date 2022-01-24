var expect = require('chai').expect;
var _ = require('lodash');
var Jobs = require('../');
var debug = require('debug')('neoplan');

var humanInterval = require('human-interval');


/**
 * scanInterval is defined in this test to make them run faster.
 * Usually you should not change this value
 */

var mongoPath = process.env.MONGOPATH || 'mongodb://localhost:27017/neoplan';
var opts = { url: mongoPath };
var J = null;

before(() => {
	J = new Jobs(_.extend({ collection: 'jobs-test', processJobs: false }, opts));

	J.on('error', function(err){
		debug('[JOBS ERROR] '+err);
	});

})

after(() => {
	debug('ALL DONE. CLOSING JOBS CONNECTION')
	if ( !J._ready ) {
		debug('Jobs processor is not in ready state');
	}
	J.close();
})


describe('Testing job processor start/stop', function(){

	this.timeout(0);

	it('should start with stopped jobs processor and start processing jobs', function(done){
		expect(J.options.nextScanAt).to.be.null;
		J.startJobsProcessing();
		expect(J.options.nextScanAt.getTime()).to.be.greaterThan(0)
		done();
	});

	it('should stop and start processing jobs', function(testDone){
		expect(J.options.nextScanAt.getTime()).to.be.greaterThan(0)
		J.stopJobsProcessing();
		expect(J.options.nextScanAt).to.be.null;

		J.defineJob('immediate-test', function(data, done){
			debug('---------> immediate test job')
			done();
			testDone();
		});

		J.now('immediate-test');


		J.startJobsProcessing();
		expect(J.options.nextScanAt.getTime()).to.be.greaterThan(0)
	});


});

