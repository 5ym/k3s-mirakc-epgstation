using System.Threading.Channels;

namespace Denpa.Agent;

/// <summary>
/// 起きたことを知らせる口 (SSE)。denpa の画面がチューナーの様子を追うのに使う。
///
/// <para>
/// 流すのは**こちらが持っている事実だけ**。
/// スキャンの進み具合はここには乗らない — 回しているのは denpa 自身だから。
/// </para>
/// </summary>
public sealed class Events
{
    private readonly Lock _gate = new();
    private readonly List<Channel<string>> _listeners = [];

    public Channel<string> Subscribe()
    {
        /*
         * 詰まった購読者に引きずられない。画面が固まっているだけで選局まで
         * 止まるのは困るので、溜まったら**古いほうを捨てる**
         */
        var queue = Channel.CreateBounded<string>(
            new BoundedChannelOptions(64) { FullMode = BoundedChannelFullMode.DropOldest });
        lock (_gate) _listeners.Add(queue);
        return queue;
    }

    public void Unsubscribe(Channel<string> queue)
    {
        lock (_gate) _listeners.Remove(queue);
        queue.Writer.TryComplete();
    }

    public void Emit(string name)
    {
        var block = $"event: {name}\ndata: {{}}\n\n";
        lock (_gate)
        {
            foreach (var listener in _listeners) listener.Writer.TryWrite(block);
        }
    }
}
