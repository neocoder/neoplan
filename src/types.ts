export type Options = {
    workerId?: number;
    url?: string;
    collection?: string;
    lockLifetime?: number; // 10 minute default lockLifetime
    concurrency?: number; // Process n jobs at a time ( lock & get )
    scanInterval?: number; // 2 sec
    nextScanAt?: Date | null; // job processor is not started
    processJobs?: boolean; // if false, current instance will not process jobs, only manage
};

type ProcessorCb = (data: any, cb: any) => void;
type ProcessorPr = (data: any) => Promise<void>;
export type Processor = ProcessorCb | ProcessorPr;

export type Job = {
    name: string;
    processor: Processor;
    opts: any;
};

export type timestamp = number;
