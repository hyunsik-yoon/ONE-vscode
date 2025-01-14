// automatically generated by the FlatBuffers compiler, do not modify

import * as flatbuffers from 'flatbuffers';

export class DepthToSpaceOptions {
  bb: flatbuffers.ByteBuffer|null = null;
  bb_pos = 0;
  __init(i: number, bb: flatbuffers.ByteBuffer): DepthToSpaceOptions {
    this.bb_pos = i;
    this.bb = bb;
    return this;
  }

  static getRootAsDepthToSpaceOptions(bb: flatbuffers.ByteBuffer, obj?: DepthToSpaceOptions):
      DepthToSpaceOptions {
    return (obj || new DepthToSpaceOptions())
        .__init(bb.readInt32(bb.position()) + bb.position(), bb);
  }

  static getSizePrefixedRootAsDepthToSpaceOptions(
      bb: flatbuffers.ByteBuffer, obj?: DepthToSpaceOptions): DepthToSpaceOptions {
    bb.setPosition(bb.position() + flatbuffers.SIZE_PREFIX_LENGTH);
    return (obj || new DepthToSpaceOptions())
        .__init(bb.readInt32(bb.position()) + bb.position(), bb);
  }

  blockSize(): number {
    const offset = this.bb!.__offset(this.bb_pos, 4);
    return offset ? this.bb!.readInt32(this.bb_pos + offset) : 0;
  }

  static startDepthToSpaceOptions(builder: flatbuffers.Builder) {
    builder.startObject(1);
  }

  static addBlockSize(builder: flatbuffers.Builder, blockSize: number) {
    builder.addFieldInt32(0, blockSize, 0);
  }

  static endDepthToSpaceOptions(builder: flatbuffers.Builder): flatbuffers.Offset {
    const offset = builder.endObject();
    return offset;
  }

  static createDepthToSpaceOptions(builder: flatbuffers.Builder, blockSize: number):
      flatbuffers.Offset {
    DepthToSpaceOptions.startDepthToSpaceOptions(builder);
    DepthToSpaceOptions.addBlockSize(builder, blockSize);
    return DepthToSpaceOptions.endDepthToSpaceOptions(builder);
  }
}
