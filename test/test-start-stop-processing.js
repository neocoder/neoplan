/* eslint-disable no-unused-expressions */
const { expect } = require('chai');
const debug = require('debug')('neoplan');

const { Neoplan: Jobs } = require('../dist/neoplan');

/**
 * scanInterval is defined in this test to make them run faster.
 * Usually you should not change this value
 */

const mongoPath = process.env.MONGOPATH || 'mongodb://localhost:27017/neoplan';
const opts = { url: mongoPath };
let J = null;

before(async () => {
    J = new Jobs({ collection: 'jobs-test', processJobs: false, ...opts });

    J.on('error', (err) => {
        debug(`[JOBS ERROR] ${err}`);
    });

    return J.connect();
});

after(() => {
    debug('ALL DONE. CLOSING JOBS CONNECTION');
    J.close();
});

describe('Testing job processor start/stop', function () {
    this.timeout(0);

    it('should start with stopped jobs processor and start processing jobs', (done) => {
        expect(J.options.nextScanAt).to.be.null;
        J.startJobsProcessing();
        expect(J.options.nextScanAt.getTime()).to.be.greaterThan(0);
        done();
    });

    it('should stop and start processing jobs', (testDone) => {
        expect(J.options.nextScanAt.getTime()).to.be.greaterThan(0);
        J.stopJobsProcessing();
        expect(J.options.nextScanAt).to.be.null;

        J.defineJob('immediate-test', (data, done) => {
            debug('---------> immediate test job');
            done();
            testDone();
        });

        J.now('immediate-test');

        J.startJobsProcessing();
        expect(J.options.nextScanAt.getTime()).to.be.greaterThan(0);
    });
});
