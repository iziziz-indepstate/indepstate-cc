#property copyright "ISCC"
#property version "1.15"
#property indicator_chart_window
#property indicator_plots 0

// Only owned chart objects and two local files are used. No trading functions.
const string PREFIX="ISCC_ADDON_TV_";
const string INPUT_FILE="iscc-addon-levels.csv";
const string ACK_FILE="iscc-addon-levels-ack.csv";

struct Marker {
   string id,revision,symbol,timeframe,tool,side;
   datetime time;
   double price;
   color lineColor;
};

color FromRgb(long rgb) {
   return (color)(((rgb & 255)<<16) | (rgb & 65280) | ((rgb>>16) & 255));
}

long ToRgb(color value) {
   long native=(long)value;
   return ((native & 255)<<16) | (native & 65280) | ((native>>16) & 255);
}

bool ReadLine(int handle,string &fields[]) {
   if(FileIsEnding(handle)) return false;
   string line=FileReadString(handle);
   StringReplace(line,"\r","");
   return StringSplit(line,'\t',fields)>0;
}

bool Load(Marker &markers[],string &generation,int &protocol) {
   int handle=FileOpen(INPUT_FILE,FILE_READ|FILE_TXT|FILE_ANSI|FILE_SHARE_READ,0,CP_UTF8);
   if(handle==INVALID_HANDLE) return false;
   string parts[];
   bool valid=ReadLine(handle,parts) && ArraySize(parts)==4 && parts[0]=="ISCC_CANDLE_LEVELS" && (parts[1]=="1" || parts[1]=="2");
   protocol=valid ? (int)StringToInteger(parts[1]) : 0;
   int count=valid ? (int)StringToInteger(parts[3]) : -1;
   if(!valid || count<0 || count>2000) {FileClose(handle);return false;}
   generation=parts[2];
   if(StringLen(generation)!=64) {FileClose(handle);return false;}
   ArrayResize(markers,count);
   for(int i=0;i<count;i++) {
      if(!ReadLine(handle,parts) || ArraySize(parts)!=(protocol==2 ? 9 : 8)) {valid=false;break;}
      markers[i].id=parts[0];markers[i].revision=parts[1];markers[i].symbol=parts[2];
      markers[i].timeframe=parts[3];markers[i].time=(datetime)StringToInteger(parts[4]);
      markers[i].price=StringToDouble(parts[5]);markers[i].tool=parts[6];markers[i].side=parts[7];
      long rgb=protocol==2 ? StringToInteger(parts[8]) : (markers[i].side=="high" ? 16737095 : 49151);
      if(rgb<0 || rgb>16777215) {valid=false;break;}
      markers[i].lineColor=FromRgb(rgb);
      if(StringLen(markers[i].id)!=24 || markers[i].price<=0 || !MathIsValidNumber(markers[i].price)
         || markers[i].time<=0 || (markers[i].tool!="line" && markers[i].tool!="ray")
         || (markers[i].side!="high" && markers[i].side!="low" && markers[i].side!="price")) {valid=false;break;}
   }
   if(valid) valid=ReadLine(handle,parts) && ArraySize(parts)==3 && parts[0]=="END" && parts[1]==generation && (int)StringToInteger(parts[2])==count;
   FileClose(handle);
   return valid;
}

bool Contains(Marker &markers[],string name,string symbol) {
   for(int i=0;i<ArraySize(markers);i++)
      if(PREFIX+markers[i].id==name && markers[i].symbol==symbol) return true;
   return false;
}

bool EnsureInteger(long chart,string name,ENUM_OBJECT_PROPERTY_INTEGER property,long expected,bool &changed) {
   long actual;
   if(!ObjectGetInteger(chart,name,property,0,actual)) return false;
   if(actual==expected) return true;
   if(!ObjectSetInteger(chart,name,property,expected)) return false;
   changed=true;
   return ObjectGetInteger(chart,name,property,0,actual) && actual==expected;
}

bool EnsurePrice(long chart,string name,double expected,bool &changed) {
   double actual;
   if(!ObjectGetDouble(chart,name,OBJPROP_PRICE,0,actual)) return false;
   if(MathAbs(actual-expected)<0.00000001) return true;
   if(!ObjectSetDouble(chart,name,OBJPROP_PRICE,0,expected)) return false;
   changed=true;
   return ObjectGetDouble(chart,name,OBJPROP_PRICE,0,actual) && MathAbs(actual-expected)<0.00000001;
}

bool EnsureTooltip(long chart,string name,string expected,bool &changed) {
   string actual;
   if(!ObjectGetString(chart,name,OBJPROP_TOOLTIP,0,actual)) return false;
   if(actual==expected) return true;
   if(!ObjectSetString(chart,name,OBJPROP_TOOLTIP,expected)) return false;
   changed=true;
   return ObjectGetString(chart,name,OBJPROP_TOOLTIP,0,actual) && actual==expected;
}

bool Draw(long chart,Marker &marker,bool &changed) {
   string name=PREFIX+marker.id;
   // The user chose native full horizontal levels in MT5 for both TV tools.
   // MT5 itself draws their prices on its standard right-hand price scale.
   // Source candle/timeframe/side and the exact confirmed price remain intact.
   int window=ObjectFind(chart,name);
   if(window>=0) {
      long type;
      if(!ObjectGetInteger(chart,name,OBJPROP_TYPE,0,type)) return false;
      if(window!=0 || type!=OBJ_HLINE) {
         if(!ObjectDelete(chart,name)) return false;
         changed=true;
         if(ObjectFind(chart,name)>=0) return false;
         window=-1;
      }
   }
   if(window<0) {
      if(!ObjectCreate(chart,name,OBJ_HLINE,0,0,marker.price)) return false;
      changed=true;
      // A queued ObjectCreate is not confirmation of an applied level.
      if(ObjectFind(chart,name)!=0) return false;
   }
   // Verify actual properties every tick; write only changed values. This also
   // repairs deleted/edited owned objects without repainting unchanged charts.
   return EnsurePrice(chart,name,marker.price,changed)
      && EnsureInteger(chart,name,OBJPROP_COLOR,marker.lineColor,changed)
      && EnsureInteger(chart,name,OBJPROP_WIDTH,1,changed)
      && EnsureInteger(chart,name,OBJPROP_STYLE,STYLE_SOLID,changed)
      && EnsureInteger(chart,name,OBJPROP_BACK,false,changed)
      && EnsureInteger(chart,name,OBJPROP_TIMEFRAMES,OBJ_ALL_PERIODS,changed)
      && EnsureInteger(chart,name,OBJPROP_SELECTABLE,false,changed)
      && EnsureInteger(chart,name,OBJPROP_SELECTED,false,changed)
      && EnsureInteger(chart,name,OBJPROP_HIDDEN,false,changed)
      && EnsureTooltip(chart,name,"TV → MT5 | "+marker.timeframe+" | "+marker.side+" | "+TimeToString(marker.time),changed);
}

int OnInit() {
   EventSetTimer(1);
   // A bounded load receipt lets the installer verify the running version.
   int status=FileOpen("iscc-addon-levels-indicator-status.csv",FILE_WRITE|FILE_TXT|FILE_ANSI|FILE_SHARE_READ,0,CP_UTF8);
   if(status!=INVALID_HANDLE) {
      FileWriteString(status,"ISCC_CANDLE_LEVELS_INDICATOR\t1.15\texisting-charts-only\t"+IntegerToString(ChartID())+"\n");
      FileClose(status);
   }
   return INIT_SUCCEEDED;
}
void OnDeinit(const int reason) {EventKillTimer();}
int OnCalculate(const int rates_total,const int prev_calculated,const datetime &time[],
   const double &open[],const double &high[],const double &low[],const double &close[],
   const long &tick_volume[],const long &volume[],const int &spread[]) {return rates_total;}

void OnTimer() {
   Marker markers[];string generation;int protocol;
   if(!Load(markers,generation,protocol)) return;
   long charts[];string symbols[];bool changed[];
   for(long chart=ChartFirst();chart>=0;chart=ChartNext(chart)) {
      int index=ArraySize(charts);
      ArrayResize(charts,index+1);ArrayResize(symbols,index+1);ArrayResize(changed,index+1);
      charts[index]=chart;symbols[index]=ChartSymbol(chart);changed[index]=false;
   }
   bool cleanupReady=true;
   for(int c=0;c<ArraySize(charts);c++) {
      long chart=charts[c];
      for(int j=ObjectsTotal(chart)-1;j>=0;j--) {
         string name=ObjectName(chart,j);
         if(StringFind(name,PREFIX)==0 && !Contains(markers,name,symbols[c])) {
            if(!ObjectDelete(chart,name) || ObjectFind(chart,name)>=0) cleanupReady=false;
            changed[c]=true;
         }
      }
   }
   if(!cleanupReady) {
      for(int c=0;c<ArraySize(charts);c++) if(changed[c]) ChartRedraw(charts[c]);
      return;
   }
   bool found[],ready[];
   ArrayResize(found,ArraySize(markers));ArrayResize(ready,ArraySize(markers));
   ArrayInitialize(found,false);ArrayInitialize(ready,true);
   for(int c=0;c<ArraySize(charts);c++) {
      for(int i=0;i<ArraySize(markers);i++) {
         if(symbols[c]!=markers[i].symbol) continue;
         found[i]=true;
         bool objectChanged=false;
         if(!Draw(charts[c],markers[i],objectChanged)) ready[i]=false;
         if(objectChanged) changed[c]=true;
      }
      // One redraw for the whole batch, and none for unchanged levels.
      if(changed[c]) ChartRedraw(charts[c]);
   }
   int output=FileOpen(ACK_FILE,FILE_WRITE|FILE_TXT|FILE_ANSI|FILE_SHARE_READ,0,CP_UTF8);
   if(output==INVALID_HANDLE) return;
   FileWriteString(output,"ISCC_CANDLE_LEVELS_ACK\t"+IntegerToString(protocol)+"\t"+generation+"\t"+IntegerToString(ArraySize(markers))+"\n");
   for(int i=0;i<ArraySize(markers);i++) {
      // A closed/missing chart stays closed. Its marker remains pending until
      // the user opens a matching chart; rendering never creates chart tabs.
      int digits=(int)SymbolInfoInteger(markers[i].symbol,SYMBOL_DIGITS);
      string row=markers[i].id+"\t"+markers[i].revision+"\t"+markers[i].symbol+"\t"
         +(found[i] && ready[i] ? "ready" : "pending")+"\t"+DoubleToString(markers[i].price,digits);
      if(protocol==2) row+="\t"+IntegerToString(ToRgb(markers[i].lineColor));
      FileWriteString(output,row+"\n");
   }
   FileWriteString(output,"END\t"+generation+"\t"+IntegerToString(ArraySize(markers))+"\n");
   FileClose(output);
}
