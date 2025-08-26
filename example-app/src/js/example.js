import { TCPClient } from '@devioarts/capacitor-tcpclient';

window.testEcho = () => {
    const inputValue = document.getElementById("echoInput").value;
    TCPClient.echo({ value: inputValue })
}
