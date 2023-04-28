import mongoose, { Types } from 'mongoose';

export interface IJob {
    _id: Types.ObjectId;
    name: string;
    data: any;
    intervalStr: string;
    interval: number;
    status: string;
    nextRunAt: Date;
    errCounter: number;
    lastError: string;
    lockedAt?: Date;
}

function getSchema(collection: string): mongoose.Schema<IJob> {
    const schema = new mongoose.Schema<IJob>(
        {
            name: { type: String, index: true },
            data: { type: Object, default: {} },
            intervalStr: String,
            interval: Number,
            status: { type: String, index: true },
            nextRunAt: Date,
            errCounter: Number,
            lastError: String,
            lockedAt: Date,
        },
        { collection, minimize: false },
    );

    schema.index({ name: 1, data: 1, status: 1 });
    schema.index({ name: 1, status: 1, lockedAt: 1 });

    return schema;
}

export default getSchema;
