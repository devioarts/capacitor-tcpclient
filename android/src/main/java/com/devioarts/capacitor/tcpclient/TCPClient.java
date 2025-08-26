package com.devioarts.capacitor.tcpclient;

import com.getcapacitor.Logger;

public class TCPClient {

    public String echo(String value) {
        Logger.info("Echo", value);
        return value;
    }
}
