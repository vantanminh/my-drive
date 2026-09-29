using System.IO.Pipes;
using System.Text.Json;
using Xunit;

namespace MyDrive.Backup.Tests;

public sealed class ControlServerTests
{
    [Fact]
    public async Task Pipe_accepts_a_request_after_a_client_disconnects_without_sending()
    {
        var root = Path.Combine(Path.GetTempPath(), "mydrive-control", Guid.NewGuid().ToString("N"));
        var database = new LocalDatabase(Path.Combine(root, "backup.db"));
        var engine = new BackupEngine(database, new MemorySecretStore(), network: new OnlineNetwork(), apis: _ => new FakeDrive());
        var pipe = "MyDrive.Backup.Tests." + Guid.NewGuid().ToString("N");
        var control = new ControlServer(engine, pipe);
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(20));
        var serve = control.ServeAsync(cts.Token);
        try
        {
            using (var dropped = new NamedPipeClientStream(".", pipe, PipeDirection.InOut, PipeOptions.Asynchronous))
            {
                await dropped.ConnectAsync(5000, cts.Token);
            }

            var ping = await RoundTripAsync(pipe, new { method = "ping" }, cts.Token);
            Assert.True(ping.GetProperty("ok").GetBoolean());
            Assert.Equal(ClientInfo.Version, ping.GetProperty("result").GetProperty("version").GetString());

            var first = RoundTripAsync(pipe, new { method = "ping" }, cts.Token);
            var second = RoundTripAsync(pipe, new { method = "status" }, cts.Token);
            await Task.WhenAll(first, second);
            Assert.True(first.Result.GetProperty("ok").GetBoolean());
            Assert.True(second.Result.GetProperty("ok").GetBoolean());
            Assert.Equal(JsonValueKind.Object, second.Result.GetProperty("result").ValueKind);
        }
        finally
        {
            cts.Cancel();
            try
            {
                await serve;
            }
            catch (OperationCanceledException)
            {
            }

            engine.Dispose();
            database.Dispose();
            try
            {
                Directory.Delete(root, recursive: true);
            }
            catch (IOException)
            {
            }
        }
    }

    private static async Task<JsonElement> RoundTripAsync(string pipe, object request, CancellationToken cancellationToken)
    {
        IOException? last = null;
        for (var attempt = 0; attempt < 6; attempt++)
        {
            try
            {
                return await PipeProtocol.RoundTripAsync(pipe, request, cancellationToken);
            }
            catch (IOException ex) when (attempt < 5)
            {
                last = ex;
                await Task.Delay(40, cancellationToken);
            }
        }

        throw last ?? new IOException("Control pipe did not accept a request.");
    }
}
