export class EngineBrokerSingleflight<T> {
  private active: Promise<T> | undefined;
  run(operation: () => Promise<T>): Promise<T> {
    if (this.active !== undefined) return this.active;
    const current = operation(); this.active = current;
    void current.then(() => { if (this.active === current) this.active = undefined; }, () => { if (this.active === current) this.active = undefined; });
    return current;
  }
}

export class EngineBrokerGenerationFence {
  private generation = 0;
  private stale = false;
  restore(generation:number):void{if(this.stale||this.generation!==0||!Number.isSafeInteger(generation)||generation<0)throw new Error("broker credential generation conflict");this.generation=generation;}
  snapshot(): number { if (this.stale) throw new Error("broker credential authority is stale"); return this.generation; }
  promote(expected: number): number { if (this.stale || expected !== this.generation) throw new Error("broker credential generation conflict"); return ++this.generation; }
  markStale(): void { this.stale = true; }
}
