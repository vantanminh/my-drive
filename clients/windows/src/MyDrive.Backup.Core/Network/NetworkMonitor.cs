using System.Net.NetworkInformation;

namespace MyDrive.Backup;

public interface INetworkMonitor
{
    NetworkSnapshot Snapshot();
}

public sealed class NetworkMonitor : INetworkMonitor
{
    public NetworkSnapshot Snapshot()
    {
        try
        {
            var interfaces = NetworkInterface.GetAllNetworkInterfaces()
                .Where(item => item.OperationalStatus == OperationalStatus.Up && item.NetworkInterfaceType != NetworkInterfaceType.Loopback)
                .ToArray();
            var wifi = interfaces.Any(item => item.NetworkInterfaceType == NetworkInterfaceType.Wireless80211);
            var ethernet = interfaces.Any(item => item.NetworkInterfaceType is NetworkInterfaceType.Ethernet or NetworkInterfaceType.GigabitEthernet);
            return new NetworkSnapshot(interfaces.Length > 0, wifi, ethernet, Metered: false, MeteredKnown: false);
        }
        catch (NetworkInformationException)
        {
            return new NetworkSnapshot(true, false, false, false, false);
        }
    }
}
